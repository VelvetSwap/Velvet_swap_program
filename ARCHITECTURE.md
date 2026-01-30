# VelvetSwap Architecture

> Technical deep-dive into the confidential AMM implementation.

---

## Privacy Layers

| Layer | Technology | What's Protected |
|-------|------------|------------------|
| **FHE (Inco Lightning)** | Homomorphic encryption | Pool reserves, swap amounts, fees stored as `Euint128` |
| **ZK (Light Protocol V2)** | Zero-knowledge proofs | Pool state in compressed accounts with validity proofs |

### Compliance Layer

**Range Protocol** provides pre-swap compliance:
- Sanctions screening (OFAC/EU/UK)
- ML-based risk scoring (blocks score ≥ 5/10)
- API: `GET https://api.range.org/v1/risk/address?network=solana`

---

## System Overview

```mermaid
graph TB
    subgraph "Client Layer"
        UI["VelvetSwap Frontend<br/>(Next.js)"]
        SDK["Swap Client SDK<br/>(TypeScript)"]
    end

    subgraph "Privacy Layer"
        INCO["Inco Lightning<br/>FHE Encryption"]
        LIGHT["Light Protocol V2<br/>ZK Compression"]
    end

    subgraph "Solana Runtime"
        PROGRAM["light_swap_psp<br/>Confidential AMM"]
        POOL[("SwapPool<br/>(Compressed)")]
    end

    UI --> SDK
    SDK --> |"Helius RPC"| PROGRAM
    PROGRAM --> INCO
    PROGRAM --> LIGHT
    PROGRAM --> POOL

    style UI fill:#7C3AED,color:#fff
    style SDK fill:#7C3AED,color:#fff
    style INCO fill:#22C55E,color:#fff
    style LIGHT fill:#3B82F6,color:#fff
    style PROGRAM fill:#9945FF,color:#fff
    style POOL fill:#1e1e2e,color:#fff,stroke:#9945FF
```

---

## Core Components

### 1. Pool State (Compressed Account)

The pool state is stored as a **Light Protocol compressed account** with FHE-encrypted fields:

```mermaid
erDiagram
    SwapPool {
        Pubkey authority "Pool admin (can add/remove liquidity)"
        Pubkey pool_authority "PDA for signing transfers"
        Pubkey mint_a "Token A mint address"
        Pubkey mint_b "Token B mint address"
        Euint128 reserve_a "ENCRYPTED: Token A reserves"
        Euint128 reserve_b "ENCRYPTED: Token B reserves"
        Euint128 protocol_fee_a "ENCRYPTED: Accumulated fees (A)"
        Euint128 protocol_fee_b "ENCRYPTED: Accumulated fees (B)"
        u16 fee_bps "Fee in basis points (e.g., 30 = 0.3%)"
        bool is_paused "Emergency pause flag"
        i64 last_update_ts "Last state update timestamp"
    }
```

### 2. Pool Authority PDA

Derived deterministically for each token pair:

```
seeds = ["pool_authority", mint_a, mint_b]
pool_authority_pda = PDA(seeds, program_id)
```

This PDA signs CPI calls to Inco Token for confidential transfers.

### 3. Compressed Account Address

Pool address is derived using Light Protocol V2:

```
seeds = ["pool", mint_a, mint_b]
address_seed = deriveAddressSeedV2(seeds)
pool_address = deriveAddressV2(address_seed, batch_address_tree, program_id)
```

---

## Instruction Flow

### Initialize Pool

```mermaid
sequenceDiagram
    participant Client
    participant LightRPC as Light RPC
    participant Program as VelvetSwap
    participant Inco as Inco Lightning
    participant Light as Light Protocol

    Client->>LightRPC: getValidityProofV0([], [new_address])
    LightRPC-->>Client: validity_proof, root_indices
    
    Client->>Program: initialize_pool(proof, mint_a, mint_b, fee_bps)
    Program->>Inco: as_euint128(0) × 4
    Note over Program,Inco: Initialize encrypted reserves & fees to zero
    
    Program->>Light: Create compressed account
    Light-->>Program: Account created at derived address
    Program-->>Client: Success
```

### Swap Exact In

```mermaid
sequenceDiagram
    participant Client
    participant Range as Range Protocol
    participant Program as VelvetSwap
    participant IncoFHE as Inco Lightning
    participant IncoToken as Inco Token
    participant Light as Light Protocol

    Client->>Range: Check compliance (risk score)
    Range-->>Client: {riskScore: 1, compliant: true}
    Client->>Client: Encrypt amounts (FHE)
    Client->>Light: Fetch pool state + validity proof
    Light-->>Client: Compressed pool data
    
    Client->>Program: swap_exact_in(proof, pool_meta, ciphertexts, a_to_b)
    
    rect rgb(50, 50, 80)
        Note over Program,IncoFHE: FHE Computation (all encrypted)
        Program->>IncoFHE: new_euint128(amount_in_ciphertext)
        Program->>IncoFHE: new_euint128(amount_out_ciphertext)
        
        Program->>IncoFHE: e_ge(reserve_out, amount_out)
        Note over IncoFHE: Check: has_liquidity?
        
        Program->>IncoFHE: e_mul(reserve_in, reserve_out)
        Note over IncoFHE: old_k = x * y
        
        Program->>IncoFHE: e_add(reserve_in, amount_in)
        Program->>IncoFHE: e_sub(reserve_out, amount_out)
        
        Program->>IncoFHE: e_mul(new_reserve_in, new_reserve_out)
        Note over IncoFHE: new_k = x' * y'
        
        Program->>IncoFHE: e_ge(new_k, old_k)
        Program->>IncoFHE: e_select(k_ok, amount, zero)
    end
    
    rect rgb(50, 80, 50)
        Note over Program,IncoToken: Confidential Token Transfers
        Program->>IncoToken: transfer(user → pool_vault, encrypted_in)
        Program->>IncoToken: transfer(pool_vault → user, encrypted_out)
    end
    
    Program->>Light: Update compressed pool state
    Light-->>Program: State finalized
    Program-->>Client: Transaction signature
```

### Add/Remove Liquidity

```mermaid
sequenceDiagram
    participant Authority
    participant Program as VelvetSwap
    participant Inco as Inco Lightning
    participant Light as Light Protocol

    Authority->>Program: add_liquidity(proof, pool_meta, amount_a, amount_b)
    
    Program->>Program: Verify authority == pool.authority
    Program->>Program: Verify !pool.is_paused
    
    Program->>Inco: new_euint128(amount_a_ciphertext)
    Program->>Inco: new_euint128(amount_b_ciphertext)
    
    Program->>Inco: e_add(reserve_a, amount_a)
    Program->>Inco: e_add(reserve_b, amount_b)
    
    Program->>Light: Update compressed pool state
    Light-->>Program: Success
    Program-->>Authority: Liquidity added
```

---

## FHE Operations Detail

### Constant Product AMM Math

The swap uses the standard `x * y = k` invariant, but **entirely on encrypted values**:

```mermaid
flowchart LR
    subgraph "Input (Encrypted)"
        AI["amount_in<br/>Euint128"]
        AO["amount_out<br/>Euint128"]
        FEE["fee_amount<br/>Euint128"]
    end

    subgraph "Pool State (Encrypted)"
        RA["reserve_a<br/>Euint128"]
        RB["reserve_b<br/>Euint128"]
    end

    subgraph "FHE Operations"
        CHK1["e_ge(reserve_out, amount_out)<br/>Liquidity check"]
        MUL1["e_mul(reserve_in, reserve_out)<br/>old_k"]
        ADD["e_add(reserve_in, amount_in)<br/>new_reserve_in"]
        SUB["e_sub(reserve_out, amount_out)<br/>new_reserve_out"]
        MUL2["e_mul(new_in, new_out)<br/>new_k"]
        CHK2["e_ge(new_k, old_k)<br/>Invariant check"]
        SEL["e_select(valid, amount, 0)<br/>Zero if invalid"]
    end

    AI --> ADD
    AO --> SUB
    RA --> MUL1
    RB --> MUL1
    RA --> ADD
    RB --> SUB
    MUL1 --> CHK2
    ADD --> MUL2
    SUB --> MUL2
    MUL2 --> CHK2
    CHK1 --> SEL
    CHK2 --> SEL

    style AI fill:#7C3AED,color:#fff
    style AO fill:#7C3AED,color:#fff
    style FEE fill:#7C3AED,color:#fff
    style RA fill:#22C55E,color:#fff
    style RB fill:#22C55E,color:#fff
```

### Operation Complexity

| Operation | Inco CPI Calls | Purpose |
|-----------|----------------|---------|
| `new_euint128` | 3 | Parse input ciphertexts |
| `as_euint128` | 1 | Create zero constant |
| `e_ge` | 2 | Liquidity + invariant checks |
| `e_add` | 2 | Update reserves |
| `e_sub` | 1 | Update output reserve |
| `e_mul` | 2 | Compute k values |
| `e_select` | 3 | Conditional zeroing |
| **Total** | **14** | Per swap |

---

## Range Protocol Integration

### Compliance Flow

```mermaid
flowchart TB
    subgraph "Pre-Swap Check"
        A[User connects wallet] --> B[Frontend calls Range API]
        B --> C{Risk Score < 5?}
        C -->|Yes| D[Allow swap]
        C -->|No| E[Block swap]
    end

    subgraph "Risk Categories"
        F[Sanctions: OFAC/EU/UK]
        G[Hack funds]
        H[Terrorism financing]
        I[High-risk behavior]
    end
```

### API Response

```typescript
interface AddressRiskResponse {
    riskScore: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    riskLevel: "Very low risk" | "Low risk" | "Medium risk" | "High risk" | "CRITICAL RISK";
    reasoning: string;
    maliciousAddressesFound: { address: string; distance: number; category: string }[];
}
```

---

## Light Protocol V2 Integration

### Compressed Account Flow

```mermaid
flowchart LR
    subgraph "State Tree"
        ROOT["Merkle Root"]
        LEAF["Pool Account<br/>(Compressed)"]
    end

    subgraph "Address Tree"
        ADDR["Batch Address Tree<br/>amt2kaJA14v3..."]
    end

    subgraph "Output Queue"
        QUEUE["Output Queue<br/>oq1na8gojfd..."]
    end

    ROOT --> LEAF
    ADDR --> LEAF
    LEAF --> QUEUE

    style ROOT fill:#3B82F6,color:#fff
    style LEAF fill:#3B82F6,color:#fff
    style ADDR fill:#3B82F6,color:#fff
    style QUEUE fill:#3B82F6,color:#fff
```

### Key Addresses (Devnet)

| Account | Address |
|---------|---------|
| Batch Address Tree | `amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx` |
| Output Queue | `oq1na8gojfdUhsfCpyjNt6h4JaDWtHf1yQj4koBWfto` |
| Light System Program | `SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7` |

---

## Error Handling

| Error | Code | Cause |
|-------|------|-------|
| `PoolPaused` | 6000 | Pool is in emergency pause state |
| `InvalidInputMint` | 6001 | Input token doesn't match pool |
| `InvalidOutputMint` | 6002 | Output token doesn't match pool |
| `InvalidPermissionAccount` | 6003 | PDA doesn't match derived address |
| `Unauthorized` | 6004 | Caller is not pool authority |

---

## Security & Compliance Model

```mermaid
flowchart TB
    subgraph "Privacy Guarantees"
        T1["Inco Lightning FHE<br/>Cryptographic security"]
        T2["Inco Token c-SPL<br/>Hidden balances"]
        T3["Light Protocol ZK<br/>Proof soundness"]
    end

    subgraph "Compliance Guarantees"
        C1["Range Protocol<br/>Sanctions screening"]
    end

    subgraph "What's Protected"
        G1["Swap amounts hidden"]
        G2["Pool reserves hidden"]
        G3["User balances hidden"]
        G4["Sanctioned addresses blocked"]
    end

    T1 --> G1
    T1 --> G2
    T2 --> G3
    T3 --> G2
    C1 --> G4
```

---

## File Structure

```
programs/light_swap_psp/src/lib.rs
├── compute_swap_updates()     # FHE swap math
├── initialize_pool()          # Pool creation with encrypted reserves
├── add_liquidity()            # LP deposit (authority only)
├── remove_liquidity()         # LP withdrawal (authority only)
├── swap_exact_in()            # Core swap with Inco Token transfers
├── SwapExactIn                # Anchor accounts context
├── SwapPool                   # Pool state struct (compressed)
└── ErrorCode                  # Custom errors
```

---

## Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| Compute Units | ~326,914 | Per swap (verified on devnet) |
| Account Size | ~500 bytes | Compressed pool state |
| Validity Proof | ~1-2 seconds | Light RPC latency |
| Compliance Check | ~200ms | Range API call |

---

## Future Improvements

1. **Multi-hop routing** — Chain multiple pools for better prices
2. **LP tokens** — Fungible representation of liquidity shares
3. **Attested reveals** — Allow users to prove their swap amounts
4. **Fee distribution** — Automated protocol fee collection
