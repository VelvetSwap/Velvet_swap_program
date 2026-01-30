import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { encryptValue } from "@inco/solana-sdk";
import { hexToBuffer } from "@inco/solana-sdk";
import {
  Rpc,
  createRpc,
  bn,
  defaultTestStateTreeAccounts,
  defaultStaticAccountsStruct,
  featureFlags,
  VERSION,
  deriveAddressSeedV2,
  deriveAddressV2,
  PackedAccounts,
  selectStateTreeInfo,
} from "@lightprotocol/stateless.js";
import { LightSwapPsp } from "../target/types/light_swap_psp";
import { IncoToken } from "../target/types/inco_token";

// Force V2 mode
(featureFlags as any).version = VERSION.V2;

// Program IDs
const INCO_LIGHTNING_PROGRAM_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");
const INCO_TOKEN_PROGRAM_ID = new PublicKey("CYVSeUyVzHGVcrxsJt3E8tbaPCQT8ASdRR45g5WxUEW7");
const INPUT_TYPE = 0;

// Light Protocol accounts
const treeAccounts = defaultTestStateTreeAccounts();
const staticAccounts = defaultStaticAccountsStruct();
const LIGHT_SYSTEM_PROGRAM = new PublicKey("SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7");

// IncoAccount size: 8 (discriminator) + 32 + 32 + 32 + 36 + 1 + 12 + 32 + 36 = 221 bytes
const INCO_ACCOUNT_SIZE = 8 + 213;
// IncoMint size: 8 (discriminator) + 36 + 32 + 1 + 1 + 36 = 114 bytes
const INCO_MINT_SIZE = 8 + 106;

describe("full_swap_e2e", function () {
  this.timeout(600000);

  const apiKey = process.env.HELIUS_DEVNET_API_KEY;
  const rpcUrl = apiKey 
    ? `https://devnet.helius-rpc.com/?api-key=${apiKey}` 
    : "https://api.devnet.solana.com";
  
  process.env.ANCHOR_PROVIDER_URL = rpcUrl;
  process.env.ANCHOR_WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, anchor.AnchorProvider.env().wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load programs
  const swapProgram = anchor.workspace.LightSwapPsp as Program<LightSwapPsp>;
  // Load inco-token IDL manually
  const incoTokenIdl = require("../deps/lightning-rod-solana/target/idl/inco_token.json");
  const incoTokenProgram = new Program(incoTokenIdl, provider);
  
  const authority = provider.wallet.publicKey;
  let lightRpc: Rpc;

  // Keypairs for mints
  const incoMintA = Keypair.generate();
  const incoMintB = Keypair.generate();
  
  // Keypairs for token accounts
  const userTokenA = Keypair.generate();
  const userTokenB = Keypair.generate();
  const poolVaultA = Keypair.generate();
  const poolVaultB = Keypair.generate();

  // Pool authority PDA
  let poolAuthorityPda: PublicKey;
  let poolAuthorityBump: number;

  const encryptAmount = async (amount: bigint) => hexToBuffer(await encryptValue(amount));

  const computeBudgetIxs = () => [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  ];

  before(async () => {
    console.log("=".repeat(70));
    console.log("Full E2E Swap Test with Inco Token Transfers");
    console.log("=".repeat(70));
    console.log("\nProgram IDs:");
    console.log("  Swap Program:", swapProgram.programId.toBase58());
    console.log("  Inco Token:", INCO_TOKEN_PROGRAM_ID.toBase58());
    console.log("  Inco Lightning:", INCO_LIGHTNING_PROGRAM_ID.toBase58());
    console.log("\nAuthority:", authority.toBase58());

    // Derive pool authority PDA using incoMintA and incoMintB as the "mints" for pool identification
    [poolAuthorityPda, poolAuthorityBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_authority"), incoMintA.publicKey.toBuffer(), incoMintB.publicKey.toBuffer()],
      swapProgram.programId
    );
    console.log("  Pool Authority PDA:", poolAuthorityPda.toBase58());

    // Initialize Light RPC
    lightRpc = createRpc(rpcUrl, rpcUrl);
    console.log("\nLight RPC initialized");

    // Check balances
    const balance = await connection.getBalance(authority);
    console.log("Authority balance:", balance / 1e9, "SOL");
    if (balance < 0.5e9) {
      console.log("⚠️ Low balance, requesting airdrop...");
      try {
        const sig = await connection.requestAirdrop(authority, 1e9);
        await connection.confirmTransaction(sig);
        console.log("Airdrop received");
      } catch (e) {
        console.log("Airdrop failed (may have hit rate limit)");
      }
    }
  });

  it("1. Creates Inco Mint A (wSOL-like)", async () => {
    console.log("\n--- Creating Inco Mint A ---");
    console.log("Mint address:", incoMintA.publicKey.toBase58());

    try {
      const tx = await incoTokenProgram.methods
        .initializeMint(9, authority, null) // 9 decimals like wSOL
        .accounts({
          mint: incoMintA.publicKey,
          payer: authority,
        })
        .preInstructions(computeBudgetIxs())
        .signers([incoMintA])
        .rpc();

      console.log("✅ Mint A created:", tx);
    } catch (error: any) {
      console.error("Failed to create Mint A:", error.message);
      if (error.logs) console.error("Logs:", error.logs.slice(-5));
      throw error;
    }
  });

  it("2. Creates Inco Mint B (USDC-like)", async () => {
    console.log("\n--- Creating Inco Mint B ---");
    console.log("Mint address:", incoMintB.publicKey.toBase58());

    try {
      const tx = await incoTokenProgram.methods
        .initializeMint(6, authority, null) // 6 decimals like USDC
        .accounts({
          mint: incoMintB.publicKey,
          payer: authority,
        })
        .preInstructions(computeBudgetIxs())
        .signers([incoMintB])
        .rpc();

      console.log("✅ Mint B created:", tx);
    } catch (error: any) {
      console.error("Failed to create Mint B:", error.message);
      if (error.logs) console.error("Logs:", error.logs.slice(-5));
      throw error;
    }
  });

  it("3. Creates User Token Account A", async () => {
    console.log("\n--- Creating User Token Account A ---");
    console.log("Account address:", userTokenA.publicKey.toBase58());

    try {
      const tx = await incoTokenProgram.methods
        .initializeAccount()
        .accounts({
          account: userTokenA.publicKey,
          mint: incoMintA.publicKey,
          owner: authority,
          payer: authority,
        })
        .preInstructions(computeBudgetIxs())
        .signers([userTokenA])
        .rpc();

      console.log("✅ User Token A created:", tx);
    } catch (error: any) {
      console.error("Failed to create User Token A:", error.message);
      if (error.logs) console.error("Logs:", error.logs.slice(-5));
      throw error;
    }
  });

  it("4. Creates User Token Account B", async () => {
    console.log("\n--- Creating User Token Account B ---");
    console.log("Account address:", userTokenB.publicKey.toBase58());

    try {
      const tx = await incoTokenProgram.methods
        .initializeAccount()
        .accounts({
          account: userTokenB.publicKey,
          mint: incoMintB.publicKey,
          owner: authority,
          payer: authority,
        })
        .preInstructions(computeBudgetIxs())
        .signers([userTokenB])
        .rpc();

      console.log("✅ User Token B created:", tx);
    } catch (error: any) {
      console.error("Failed to create User Token B:", error.message);
      if (error.logs) console.error("Logs:", error.logs.slice(-5));
      throw error;
    }
  });

  it("5. Creates Pool Vault A (owned by pool authority)", async () => {
    console.log("\n--- Creating Pool Vault A ---");
    console.log("Vault address:", poolVaultA.publicKey.toBase58());
    console.log("Owner (pool authority):", poolAuthorityPda.toBase58());

    try {
      const tx = await incoTokenProgram.methods
        .initializeAccount()
        .accounts({
          account: poolVaultA.publicKey,
          mint: incoMintA.publicKey,
          owner: poolAuthorityPda,
          payer: authority,
        })
        .preInstructions(computeBudgetIxs())
        .signers([poolVaultA])
        .rpc();

      console.log("✅ Pool Vault A created:", tx);
    } catch (error: any) {
      console.error("Failed to create Pool Vault A:", error.message);
      if (error.logs) console.error("Logs:", error.logs.slice(-5));
      throw error;
    }
  });

  it("6. Creates Pool Vault B (owned by pool authority)", async () => {
    console.log("\n--- Creating Pool Vault B ---");
    console.log("Vault address:", poolVaultB.publicKey.toBase58());
    console.log("Owner (pool authority):", poolAuthorityPda.toBase58());

    try {
      const tx = await incoTokenProgram.methods
        .initializeAccount()
        .accounts({
          account: poolVaultB.publicKey,
          mint: incoMintB.publicKey,
          owner: poolAuthorityPda,
          payer: authority,
        })
        .preInstructions(computeBudgetIxs())
        .signers([poolVaultB])
        .rpc();

      console.log("✅ Pool Vault B created:", tx);
    } catch (error: any) {
      console.error("Failed to create Pool Vault B:", error.message);
      if (error.logs) console.error("Logs:", error.logs.slice(-5));
      throw error;
    }
  });

  it("7. Mints tokens to User Token A (for swap input)", async () => {
    console.log("\n--- Minting to User Token A ---");
    const amount = BigInt(10_000_000_000); // 10 tokens (9 decimals)
    console.log("Amount:", amount.toString(), "(10 tokens)");

    try {
      const encryptedAmount = await encryptAmount(amount);
      console.log("Encrypted amount:", encryptedAmount.length, "bytes");

      const tx = await incoTokenProgram.methods
        .mintTo(Buffer.from(encryptedAmount), INPUT_TYPE)
        .accounts({
          mint: incoMintA.publicKey,
          account: userTokenA.publicKey,
          mintAuthority: authority,
        })
        .preInstructions(computeBudgetIxs())
        .rpc();

      console.log("✅ Minted to User Token A:", tx);
    } catch (error: any) {
      console.error("Failed to mint to User Token A:", error.message);
      if (error.logs) console.error("Logs:", error.logs.slice(-5));
      throw error;
    }
  });

  it("8. Mints tokens to Pool Vault B (pool liquidity)", async () => {
    console.log("\n--- Minting to Pool Vault B (liquidity) ---");
    const amount = BigInt(100_000_000); // 100 USDC (6 decimals)
    console.log("Amount:", amount.toString(), "(100 USDC)");

    try {
      const encryptedAmount = await encryptAmount(amount);
      console.log("Encrypted amount:", encryptedAmount.length, "bytes");

      const tx = await incoTokenProgram.methods
        .mintTo(Buffer.from(encryptedAmount), INPUT_TYPE)
        .accounts({
          mint: incoMintB.publicKey,
          account: poolVaultB.publicKey,
          mintAuthority: authority,
        })
        .preInstructions(computeBudgetIxs())
        .rpc();

      console.log("✅ Minted to Pool Vault B:", tx);
    } catch (error: any) {
      console.error("Failed to mint to Pool Vault B:", error.message);
      if (error.logs) console.error("Logs:", error.logs.slice(-5));
      throw error;
    }
  });

  it("9. Summary and next steps", async () => {
    console.log("\n" + "=".repeat(70));
    console.log("E2E Setup Complete!");
    console.log("=".repeat(70));
    
    console.log("\nCreated Accounts:");
    console.log("  Inco Mint A (wSOL):", incoMintA.publicKey.toBase58());
    console.log("  Inco Mint B (USDC):", incoMintB.publicKey.toBase58());
    console.log("  User Token A:", userTokenA.publicKey.toBase58());
    console.log("  User Token B:", userTokenB.publicKey.toBase58());
    console.log("  Pool Vault A:", poolVaultA.publicKey.toBase58());
    console.log("  Pool Vault B:", poolVaultB.publicKey.toBase58());
    console.log("  Pool Authority:", poolAuthorityPda.toBase58());

    console.log("\nTo execute a full swap, you need to:");
    console.log("1. Initialize Light Protocol pool with these mints");
    console.log("2. Call swap_exact_in with:");
    console.log("   - Encrypted amount_in, amount_out, fee_amount");
    console.log("   - All token accounts (user + pool vaults)");
    console.log("   - Light Protocol remaining accounts");
    
    console.log("\n✅ All token infrastructure ready for swaps!");
  });
});
