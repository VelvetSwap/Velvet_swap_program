# VelvetSwap — Confidential AMM for Solana

[![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF)](https://solana.com)
[![Light Protocol](https://img.shields.io/badge/Light%20Protocol-V2-3B82F6)](https://lightprotocol.com)
[![Inco Network](https://img.shields.io/badge/Inco-FHE-22C55E)](https://inco.network)
[![Range Protocol](https://img.shields.io/badge/Range-Compliance-3B82F6)](https://range.org)

## Privacy + Compliance Stack

| Layer | Technology | Purpose |
|-------|------------|------------------|
| **FHE (Inco Lightning)** | Homomorphic encryption | Pool reserves, swap amounts, fees - all encrypted as `Euint128` |
| **c-SPL (Inco Token)** | Confidential tokens | User balances stored encrypted, transfers hide amounts |
| **ZK (Light Protocol V2)** | Zero-knowledge proofs | Pool state stored as compressed account with validity proofs |
| **Compliance (Range)** | Risk API | Sanctions screening & wallet risk scoring before swaps |

---

## Overview

VelvetSwap is a **constant-product AMM** where nobody — not validators, not indexers, not MEV bots — can see how much you're swapping.

```mermaid
graph TB
    subgraph "Privacy + Compliance Stack"
        A[/"Swap Amounts"/] --> INCO["Inco Lightning<br/>(FHE Encryption)"]
        B[/"Token Balances"/] --> TOKEN["Inco Token<br/>(c-SPL)"]
        C[/"Pool State"/] --> LIGHT["Light Protocol<br/>(ZK Compression)"]
        D[/"Wallet Risk"/] --> RANGE["Range Protocol<br/>(Compliance API)"]
    end
    
    INCO --> PROGRAM["VelvetSwap Program"]
    TOKEN --> PROGRAM
    LIGHT --> PROGRAM
    RANGE -.->|Pre-swap check| PROGRAM
    
    style A fill:#7C3AED,color:#fff
    style B fill:#7C3AED,color:#fff
    style C fill:#7C3AED,color:#fff
    style D fill:#3B82F6,color:#fff
    style INCO fill:#1e1e2e,color:#fff,stroke:#22C55E
    style TOKEN fill:#1e1e2e,color:#fff,stroke:#22C55E
    style LIGHT fill:#1e1e2e,color:#fff,stroke:#7C3AED
    style RANGE fill:#1e1e2e,color:#fff,stroke:#3B82F6
    style PROGRAM fill:#9945FF,color:#fff
```

---

## Deployed Program

| Field | Value |
|-------|-------|
| **Program ID** | `4b8jCufu7b4WKXdxFRQHWSks4QdskW62qF7tApSNXuZD` |
| **Network** | Solana Devnet |
| **Inco Token Program** | `CYVSeUyVzHGVcrxsJt3E8tbaPCQT8ASdRR45g5WxUEW7` |
| **Inco Lightning Program** | `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj` |
| **Pool Authority PDA** | `DSM8WDdZ5s3xkKbjtmzxpd59J42cuTZ1AJtFJTzLMkFS` |
| **Inco Mint A (wSOL)** | `4AJDgxnHDNP7y9wSD24sP7YUhQrMyprLUeuRwEwYu6cy` |
| **Inco Mint B (USDC)** | `CvymLX1Tm6btpRJdfGeQ34k726yQnXSn1V7G4fworMaG` |
| **Pool Vault A** | `8cEgrChzTtBxucAFqSnM5QAR1NuKRZEs5Z1U9QEfLsKi` |
| **Pool Vault B** | `DoESWTXqLEiKyUWVUGKXhTQXrL3oN5HLiRxG781W8Hwx` |
| **Example Swap TX** | [View on Explorer](https://explorer.solana.com/tx/3kbJFHbfGKVKyf6xEs5jLnWcYnRjh7mNQa6o6kXjbRhGQb8kQMhnzhFaQA8WDE4joHGExxmguSRTJfGqMXpeHogB?cluster=devnet) |

---

## Privacy Architecture

### What's Hidden?

| Data | Visibility | Technology |
|------|------------|------------|
| Swap input amount | **Encrypted** | Inco FHE `Euint128` |
| Swap output amount | **Encrypted** | Inco FHE `Euint128` |
| Pool reserves (A & B) | **Encrypted** | Inco FHE `Euint128` |
| Protocol fees | **Encrypted** | Inco FHE `Euint128` |
| Pool state location | **Compressed** | Light Protocol ZK proofs |
| Token balances | **Encrypted** | Inco Token c-SPL |

### Confidential Swap Flow

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Range as Range Protocol
    participant Program as VelvetSwap
    participant IncoToken as Inco Token (c-SPL)
    participant IncoFHE as Inco Lightning (FHE)
    participant Light as Light Protocol

    User->>Frontend: Connect wallet + Enter 0.03 SOL
    
    Note over Frontend,Range: Compliance Check (Pre-swap)
    Frontend->>Range: GET /v1/risk/address?network=solana
    Range-->>Frontend: {riskScore: 1, isCompliant: true}
    
    Frontend->>Frontend: Encrypt amount as Euint128
    Frontend->>Light: Fetch pool state + validity proof
    Light-->>Frontend: Compressed pool data
    Frontend->>Program: swap_exact_in(encrypted_amounts)
    
    Note over Program,IncoFHE: FHE Arithmetic on Encrypted Values
    Program->>IncoFHE: e_add(reserve_in, amount_in)
    Program->>IncoFHE: e_sub(reserve_out, amount_out)
    Program->>IncoFHE: e_select() for conditional updates
    
    Note over Program,IncoToken: Confidential Token Transfers
    Program->>IncoToken: transfer(user → pool_vault, encrypted_in)
    Program->>IncoToken: transfer(pool_vault → user, encrypted_out)
    
    Program->>Light: Commit updated pool state
    Light-->>Program: State finalized
    Program-->>Frontend: Transaction signature
    Frontend-->>User: "Private swap completed!"
```

---

## Program Instructions

| Instruction | Description | Access |
|-------------|-------------|--------|
| `initialize_pool` | Create compressed pool with encrypted zero reserves | Anyone |
| `add_liquidity` | Add encrypted liquidity to pool | Authority only |
| `remove_liquidity` | Remove encrypted liquidity from pool | Authority only |
| `swap_exact_in` | Execute private swap with FHE constant-product math | Anyone |
| `swap_exact_out` | Execute private swap specifying exact output | Anyone |

---

## Pool State (Encrypted)

```mermaid
classDiagram
    class SwapPool {
        +Pubkey authority
        +Pubkey pool_authority
        +Pubkey mint_a
        +Pubkey mint_b
        +Euint128 reserve_a
        +Euint128 reserve_b
        +Euint128 protocol_fee_a
        +Euint128 protocol_fee_b
        +u16 fee_bps
        +bool is_paused
        +i64 last_update_ts
    }
    
    note for SwapPool "All reserve and fee fields are<br/>FHE-encrypted Euint128 values"
```

---

## FHE Operations

The program uses Inco Lightning's encrypted arithmetic for all pool math:

```rust
// Encrypted addition: reserve + amount
e_add(reserve_in, amount_in)

// Encrypted subtraction: reserve - amount  
e_sub(reserve_out, amount_out)

// Encrypted multiplication: x * y = k
e_mul(reserve_a, reserve_b)

// Encrypted comparison: new_k >= old_k
e_ge(new_k, old_k)

// Encrypted conditional: if condition then a else b
e_select(has_liquidity, amount, zero)
```

---

## Repository Structure

```
private_swap_programs/
├── programs/
│   └── light_swap_psp/
│       └── src/lib.rs          # Main program (527 lines)
├── tests/
│   └── light_swap_psp.ts       # Integration tests
├── scripts/
│   └── init-permanent-pool.ts  # Pool initialization script
├── target/
│   ├── idl/light_swap_psp.json # Program IDL
│   └── types/                  # TypeScript types
├── Anchor.toml
├── Cargo.toml
└── package.json
```

---

## Quick Start

### Prerequisites

- Solana CLI with devnet configured
- Node.js 18+
- Anchor 0.32+

### Install & Test

```bash
# Install dependencies
npm install

# Initialize permanent SOL/USDC pool (one-time)
npm run init-pool

# Run integration tests
npm run ts-mocha

# Deploy program (requires devnet SOL)
anchor deploy --provider.cluster devnet
```

### Environment Variables

```bash
# Optional: Use your own Helius API key for better rate limits
export HELIUS_DEVNET_API_KEY=your_key_here

# Wallet path (defaults to ~/.config/solana/id.json)
export ANCHOR_WALLET=/path/to/wallet.json
```

---

## Integration Example

```typescript
import { initializePool, swapExactIn, fetchPoolState } from './swap-client';

// Check if pool exists
const pool = await fetchPoolState(WSOL_MINT, USDC_MINT);

// Execute encrypted swap
const tx = await swapExactIn({
    connection,
    wallet,
    mintA: WSOL_MINT,
    mintB: USDC_MINT,
    amountInCiphertext: encryptedAmount,
    amountOutCiphertext: encryptedOutput,
    feeAmountCiphertext: encryptedFee,
    aToB: true,
});
```

---

## Security & Compliance

- **FHE Encryption**: All amounts are encrypted client-side before submission
- **ZK Proofs**: Light Protocol validates state transitions without revealing data
- **Confidential Tokens**: Inco Token c-SPL hides user balances from observers
- **Sanctions Screening**: Range Protocol checks wallets against OFAC/EU/UK sanctions lists
- **Risk Scoring**: ML-based threat detection blocks high-risk addresses (score ≥ 5/10)
- **Authority Controls**: Only pool authority can add/remove liquidity

---

## Related Links

| Resource | URL |
|----------|-----|
| Frontend | [velvet-rope](../velvet-rope) |
| Inco Lightning Docs | https://docs.inco.org/svm/home |
| Light Protocol Docs | https://docs.lightprotocol.com |
| Range Protocol Docs | https://docs.range.org/risk-api/risk-introduction |
| Range Risk API | https://api.range.org/v1/risk/address |

---

## License

MIT

---

<p align="center">
  Built for <strong>Solana Privacy Hackathon 2026</strong> 🏴‍☠️
</p>
