/**
 * Setup Devnet Accounts for Inco Token Swap
 * 
 * This script creates persistent IncoMints and pool vaults that can be used
 * by the frontend. Run once to set up, then use the generated config.
 * 
 * Usage: npx ts-node scripts/setup-devnet-accounts.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { encryptValue } from "@inco/solana-sdk";
import { hexToBuffer } from "@inco/solana-sdk";
import * as fs from "fs";
import * as path from "path";

// Program IDs
const INCO_LIGHTNING_PROGRAM_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");
const INCO_TOKEN_PROGRAM_ID = new PublicKey("CYVSeUyVzHGVcrxsJt3E8tbaPCQT8ASdRR45g5WxUEW7");
const SWAP_PROGRAM_ID = new PublicKey("4b8jCufu7b4WKXdxFRQHWSks4QdskW62qF7tApSNXuZD");

const INPUT_TYPE = 0;

// Config file path
const CONFIG_PATH = path.join(__dirname, "../devnet-config.json");

interface DevnetConfig {
  incoMintA: string;  // wSOL-like (9 decimals)
  incoMintB: string;  // USDC-like (6 decimals)
  poolVaultA: string;
  poolVaultB: string;
  poolAuthorityPda: string;
  incoTokenProgram: string;
  incoLightningProgram: string;
  swapProgram: string;
}

async function main() {
  console.log("=".repeat(60));
  console.log("Setting up Devnet Accounts for Inco Token Swap");
  console.log("=".repeat(60));

  // Setup connection and provider
  const rpcUrl = process.env.HELIUS_DEVNET_API_KEY
    ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_DEVNET_API_KEY}`
    : "https://api.devnet.solana.com";
  
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = anchor.AnchorProvider.env().wallet;
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const authority = wallet.publicKey;
  console.log("\nAuthority:", authority.toBase58());

  // Load inco-token program
  const incoTokenIdl = require("../deps/lightning-rod-solana/target/idl/inco_token.json");
  const incoTokenProgram = new Program(incoTokenIdl, provider);

  // Generate keypairs for persistent accounts
  const incoMintA = Keypair.generate();
  const incoMintB = Keypair.generate();
  const poolVaultA = Keypair.generate();
  const poolVaultB = Keypair.generate();

  // Derive pool authority PDA
  const [poolAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority"), incoMintA.publicKey.toBuffer(), incoMintB.publicKey.toBuffer()],
    SWAP_PROGRAM_ID
  );

  console.log("\nGenerated Addresses:");
  console.log("  Inco Mint A (wSOL):", incoMintA.publicKey.toBase58());
  console.log("  Inco Mint B (USDC):", incoMintB.publicKey.toBase58());
  console.log("  Pool Vault A:", poolVaultA.publicKey.toBase58());
  console.log("  Pool Vault B:", poolVaultB.publicKey.toBase58());
  console.log("  Pool Authority PDA:", poolAuthorityPda.toBase58());

  const computeBudgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  ];

  const encryptAmount = async (amount: bigint) => hexToBuffer(await encryptValue(amount));

  // 1. Create Inco Mint A (wSOL-like, 9 decimals)
  console.log("\n1. Creating Inco Mint A (wSOL-like)...");
  try {
    const tx = await incoTokenProgram.methods
      .initializeMint(9, authority, null)
      .accounts({
        mint: incoMintA.publicKey,
        payer: authority,
      })
      .preInstructions(computeBudgetIxs)
      .signers([incoMintA])
      .rpc();
    console.log("   ✅ Created:", tx);
  } catch (e: any) {
    console.error("   ❌ Failed:", e.message);
    throw e;
  }

  // 2. Create Inco Mint B (USDC-like, 6 decimals)
  console.log("\n2. Creating Inco Mint B (USDC-like)...");
  try {
    const tx = await incoTokenProgram.methods
      .initializeMint(6, authority, null)
      .accounts({
        mint: incoMintB.publicKey,
        payer: authority,
      })
      .preInstructions(computeBudgetIxs)
      .signers([incoMintB])
      .rpc();
    console.log("   ✅ Created:", tx);
  } catch (e: any) {
    console.error("   ❌ Failed:", e.message);
    throw e;
  }

  // 3. Create Pool Vault A (owned by pool authority PDA)
  console.log("\n3. Creating Pool Vault A...");
  try {
    const tx = await incoTokenProgram.methods
      .initializeAccount()
      .accounts({
        account: poolVaultA.publicKey,
        mint: incoMintA.publicKey,
        owner: poolAuthorityPda,
        payer: authority,
      })
      .preInstructions(computeBudgetIxs)
      .signers([poolVaultA])
      .rpc();
    console.log("   ✅ Created:", tx);
  } catch (e: any) {
    console.error("   ❌ Failed:", e.message);
    throw e;
  }

  // 4. Create Pool Vault B (owned by pool authority PDA)
  console.log("\n4. Creating Pool Vault B...");
  try {
    const tx = await incoTokenProgram.methods
      .initializeAccount()
      .accounts({
        account: poolVaultB.publicKey,
        mint: incoMintB.publicKey,
        owner: poolAuthorityPda,
        payer: authority,
      })
      .preInstructions(computeBudgetIxs)
      .signers([poolVaultB])
      .rpc();
    console.log("   ✅ Created:", tx);
  } catch (e: any) {
    console.error("   ❌ Failed:", e.message);
    throw e;
  }

  // 5. Mint initial liquidity to Pool Vault B (100 USDC)
  console.log("\n5. Minting initial liquidity to Pool Vault B (100 USDC)...");
  try {
    const amount = BigInt(100_000_000); // 100 USDC (6 decimals)
    const encryptedAmount = await encryptAmount(amount);
    const tx = await incoTokenProgram.methods
      .mintTo(Buffer.from(encryptedAmount), INPUT_TYPE)
      .accounts({
        mint: incoMintB.publicKey,
        account: poolVaultB.publicKey,
        mintAuthority: authority,
      })
      .preInstructions(computeBudgetIxs)
      .rpc();
    console.log("   ✅ Minted:", tx);
  } catch (e: any) {
    console.error("   ❌ Failed:", e.message);
    throw e;
  }

  // 6. Save config
  const config: DevnetConfig = {
    incoMintA: incoMintA.publicKey.toBase58(),
    incoMintB: incoMintB.publicKey.toBase58(),
    poolVaultA: poolVaultA.publicKey.toBase58(),
    poolVaultB: poolVaultB.publicKey.toBase58(),
    poolAuthorityPda: poolAuthorityPda.toBase58(),
    incoTokenProgram: INCO_TOKEN_PROGRAM_ID.toBase58(),
    incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID.toBase58(),
    swapProgram: SWAP_PROGRAM_ID.toBase58(),
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log("\n6. Saved config to:", CONFIG_PATH);

  console.log("\n" + "=".repeat(60));
  console.log("Setup Complete!");
  console.log("=".repeat(60));
  console.log("\nTo create a user token account, run:");
  console.log("  npx ts-node scripts/create-user-account.ts <wallet_pubkey>");
  console.log("\nConfig saved to devnet-config.json");
}

main().catch(console.error);
