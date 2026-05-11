# VelvetMesh by VelvetSwap

> No shared pools. No leaked intent. Verified private fills.

VelvetMesh is the product evolution of VelvetSwap.

VelvetSwap started as the confidential AMM and settlement foundation on Solana.
VelvetMesh adds a private intent and RFQ layer on top of that foundation so the
user flow becomes:

1. Create a private trade intent.
2. Collect private maker/filler quotes.
3. Request a private match boundary through Arcium.
4. Accept the selected quote once it is verified.
5. Settle privately through MagicBlock and shield the payout through Umbra.

The repo keeps the original confidential AMM path intact. VelvetMesh is not a
rewrite of VelvetSwap. It is the private product layer beside it.

## Product Thesis

VelvetMesh is a private P2P intent/RFQ network for Solana. Users express hidden
trade intent and the system routes the accepted fill through the most suitable
private settlement path.

- **Arcium** is the private match boundary.
- **MagicBlock** is the private payment execution rail.
- **Umbra** is the shielded payout/balance rail.
- **Jupiter** remains the public quote reference and fallback comparison rail.
- **VelvetSwap** remains the confidential AMM fallback and settlement base.

This is the product boundary the repo now communicates everywhere:

- private intent creation
- private quote collection
- verifier-gated match recording
- settlement handoff preparation
- confirmed settlement readiness

## What Exists In This Repo

There are two main on-chain layers:

- `programs/light_swap_psp`: the existing VelvetSwap confidential AMM scaffold.
- `programs/velvet_mesh`: the VelvetMesh private intent/RFQ state machine.

The current implementation favors honest product boundaries over fake
completeness:

- Arcium-backed intents cannot be accepted until the verified match path is
  recorded.
- Sponsor settlement is gated by explicit settlement handoff state.
- Missing payloads or verifier mismatches fail closed.
- The confidential AMM path is still treated as the fallback foundation, not a
  replacement for the private intent layer.

## Current Flow

```txt
create_intent
  -> submit_quote
  -> request_private_match
  -> record_private_match
  -> accept_quote
  -> prepare_settlement_handoff
  -> mark_settlement_ready
```

The important trust boundary is `record_private_match`. It is the point where
an Arcium computation result becomes an accepted private match. Until that
happens, settlement should remain blocked.

## Program Surface

### `light_swap_psp`

This is the existing confidential AMM and settlement foundation. It uses Light
Protocol compressed state, Inco encrypted values, Inco Token confidential
transfers, and the existing Solana settlement path.

### `velvet_mesh`

This is the new private intent/RFQ state machine. It stores:

- encrypted intent parameters
- maker quote commitments
- match verifier authority
- Arcium computation request/result fields
- settlement provider and handoff state
- accepted match and settlement readiness metadata

### Sponsor Rails

The repo also includes sponsor adapter boundaries for:

- Arcium matcher integration
- MagicBlock private payment handoff
- Umbra shielded payout handoff

Those adapters are part of the real product path. They are not decorative
badges.

## On-Chain Program IDs

### VelvetSwap / AMM Foundation

| Field | Value |
|-------|-------|
| Program ID | `4b8jCufu7b4WKXdxFRQHWSks4QdskW62qF7tApSNXuZD` |
| Network | Solana Devnet |
| Inco Token Program | `CYVSeUyVzHGVcrxsJt3E8tbaPCQT8ASdRR45g5WxUEW7` |
| Inco Lightning Program | `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj` |
| Pool Authority PDA | `DSM8WDdZ5s3xkKbjtmzxpd59J42cuTZ1AJtFJTzLMkFS` |

### VelvetMesh

| Field | Value |
|-------|-------|
| Program | `programs/velvet_mesh` |
| Match flow | `create_intent -> request_private_match -> record_private_match -> accept_quote` |
| Settlement flow | `prepare_settlement_handoff -> mark_settlement_ready` |

## Repo Structure

```txt
programs/
  light_swap_psp/     # existing VelvetSwap confidential AMM
  velvet_mesh/        # private intent/RFQ program

arcium/
  velvet_mesh_matcher/ # isolated Arcium matcher workspace

src/
  sponsors/           # MagicBlock / Umbra sponsor adapters
  tests/              # devnet verification scripts

README.md
ARCHITECTURE.md
```

## Development Notes

- The repo is intentionally strict about not claiming production-complete
  encrypted AMM math until the fallback path is actually implemented and
  verified.
- Ika is parked in the current product story. The repo should not overstate it
  as an active sponsor path.
- The product direction is private intents first, then private settlement, then
  fallback AMM behavior when needed.

## Local Validation

Typical validation commands:

```bash
cargo test
cargo check
npm test
```

If you are working on the Arcium workspace, validate that workspace separately
from the main Anchor program.

## Related Frontend

The matching frontend lives in the separate VelvetMesh frontend repo:

- `https://github.com/N-45div/Velvet_frontend.git`

That frontend shows the private intent lifecycle, market reference, and
settlement receipts for the connected wallet.

