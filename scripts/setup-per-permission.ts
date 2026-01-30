/**
 * Setup PER Permission Script
 * 
 * Creates MagicBlock PER permission for the wSOL/USDC pool authority PDA
 * This is required before swaps can be executed through TEE.
 * 
 * Run with: npx ts-node scripts/setup-per-permission.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import * as nacl from "tweetnacl";
import {
  AUTHORITY_FLAG,
  TX_LOGS_FLAG,
  TX_BALANCES_FLAG,
  TX_MESSAGE_FLAG,
  ACCOUNT_SIGNATURES_FLAG,
  Member,
  createDelegatePermissionInstruction,
  getAuthToken,
  permissionPdaFromAccount,
  waitUntilPermissionActive,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { LightSwapPsp } from "../target/types/light_swap_psp";

// Fixed devnet mints (same as velvet-rope frontend)
const DEVNET_WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// MagicBlock TEE
const TEE_URL = "https://tee.magicblock.app";
const ER_VALIDATOR = new PublicKey("FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA");

async function main() {
  console.log("=".repeat(60));
  console.log("PER Permission Setup for wSOL/USDC Pool");
  console.log("=".repeat(60));

  // Configuration
  const HELIUS_API_KEY = process.env.HELIUS_DEVNET_API_KEY || "2d8978c6-7067-459f-ae97-7ea035f1a0cb";
  const rpcUrl = `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  
  process.env.ANCHOR_PROVIDER_URL = rpcUrl;
  process.env.ANCHOR_WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    anchor.AnchorProvider.env().wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const swapProgram = anchor.workspace.LightSwapPsp as Program<LightSwapPsp>;
  const authority = provider.wallet.publicKey;

  console.log("\nConfiguration:");
  console.log("  Authority:", authority.toBase58());
  console.log("  Program ID:", swapProgram.programId.toBase58());
  console.log("  Mint A (wSOL):", DEVNET_WSOL_MINT.toBase58());
  console.log("  Mint B (USDC):", DEVNET_USDC_MINT.toBase58());

  // Derive pool authority PDA
  const [poolAuthorityPda, poolAuthorityBump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool_authority"),
      DEVNET_WSOL_MINT.toBuffer(),
      DEVNET_USDC_MINT.toBuffer(),
    ],
    swapProgram.programId
  );
  const permissionForPoolAuthority = permissionPdaFromAccount(poolAuthorityPda);

  console.log("\nPDA Details:");
  console.log("  Pool Authority PDA:", poolAuthorityPda.toBase58());
  console.log("  Permission PDA:", permissionForPoolAuthority.toBase58());

  // Get TEE validator identity
  let validator = ER_VALIDATOR;
  console.log("\nConnecting to TEE...");
  
  try {
    const authToken = await getAuthToken(
      TEE_URL,
      authority,
      (message: Uint8Array) =>
        Promise.resolve(
          nacl.sign.detached(message, (provider.wallet as any).payer.secretKey)
        )
    );
    
    const teeConnection = new Connection(`${TEE_URL}?token=${authToken.token}`, "confirmed");
    
    try {
      const identityResponse = await (teeConnection as any)._rpcRequest("getIdentity", []);
      const identity = identityResponse?.result?.identity;
      if (identity) {
        validator = new PublicKey(identity);
        console.log("  TEE Validator:", validator.toBase58());
      }
    } catch (e) {
      console.log("  Using default validator:", validator.toBase58());
    }
  } catch (e: any) {
    console.log("  TEE auth failed, using default validator:", validator.toBase58());
  }

  // Create permission members
  const members: Member[] = [
    {
      flags: AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG,
      pubkey: authority,
    },
    {
      flags: AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG,
      pubkey: poolAuthorityPda,
    },
    {
      flags: AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG,
      pubkey: validator,
    },
    {
      flags: AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG,
      pubkey: swapProgram.programId,
    },
  ];

  console.log("\nCreating PER permission...");
  
  try {
    // Create permission instruction
    const createPermissionIx = await swapProgram.methods
      .createPermission(
        { poolAuthority: { mintA: DEVNET_WSOL_MINT, mintB: DEVNET_USDC_MINT } },
        members
      )
      .accounts({
        permissionedAccount: poolAuthorityPda,
        permission: permissionForPoolAuthority,
        payer: authority,
      })
      .instruction();

    // Delegate permission instruction
    const delegatePermissionIx = createDelegatePermissionInstruction({
      payer: authority,
      validator,
      permissionedAccount: [poolAuthorityPda, false],
      authority: [authority, true],
    });

    // Build and send transaction
    const tx = new anchor.web3.Transaction().add(
      createPermissionIx,
      delegatePermissionIx
    );
    tx.feePayer = authority;
    
    const sig = await provider.sendAndConfirm(tx, []);
    console.log("  ✅ Permission created:", sig);

    // Wait for permission to be active
    console.log("\nWaiting for permission to be active...");
    const isActive = await waitUntilPermissionActive(
      TEE_URL,
      poolAuthorityPda,
      60000
    );
    
    if (isActive) {
      console.log("  ✅ Pool authority permission is ACTIVE");
    } else {
      console.log("  ⚠️ Permission not active yet (may take a few more seconds)");
    }

    console.log("\n" + "=".repeat(60));
    console.log("PER PERMISSION SETUP COMPLETE");
    console.log("=".repeat(60));
    console.log("The wSOL/USDC pool can now execute swaps through TEE!");
    console.log("Explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet");

  } catch (error: any) {
    if (error.message?.includes("already in use") || error.logs?.some((l: string) => l.includes("already in use"))) {
      console.log("  ℹ️ Permission already exists!");
      
      // Check if it's active
      console.log("\nChecking if permission is active...");
      const isActive = await waitUntilPermissionActive(
        TEE_URL,
        poolAuthorityPda,
        5000
      );
      
      if (isActive) {
        console.log("  ✅ Pool authority permission is ACTIVE");
        console.log("\nThe wSOL/USDC pool is ready for TEE execution!");
      } else {
        console.log("  ⚠️ Permission exists but may not be active yet");
      }
    } else {
      console.error("❌ Permission setup failed:", error.message);
      if (error.logs) {
        console.error("Logs:", error.logs.slice(-10).join("\n"));
      }
      throw error;
    }
  }
}

main().catch(console.error);
