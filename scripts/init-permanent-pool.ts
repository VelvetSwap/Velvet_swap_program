/**
 * Initialize Permanent Pool Script
 * 
 * Creates a permanent SOL/USDC pool on devnet with fixed mints so the frontend
 * can be tested by anyone without needing to initialize the pool first.
 * 
 * Run with: npx ts-node scripts/init-permanent-pool.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import {
  Rpc,
  createRpc,
  bn,
  deriveAddressSeedV2,
  deriveAddressV2,
  PackedAccounts,
  SystemAccountMetaConfig,
  featureFlags,
  VERSION,
  batchAddressTree,
} from "@lightprotocol/stateless.js";
import { LightSwapPsp } from "../target/types/light_swap_psp";

// Force V2 mode
(featureFlags as any).version = VERSION.V2;

// ============================================
// FIXED DEVNET MINTS - Same as velvet-rope frontend
// ============================================
const DEVNET_WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// Inco Lightning Program
const INCO_LIGHTNING_PROGRAM_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// Light Protocol V2 accounts
const LIGHT_BATCH_ADDRESS_TREE = new PublicKey(batchAddressTree);
const LIGHT_OUTPUT_QUEUE = new PublicKey("oq1na8gojfdUhsfCpyjNt6h4JaDWtHf1yQj4koBWfto");

async function main() {
  console.log("=".repeat(60));
  console.log("Permanent Pool Initialization Script");
  console.log("=".repeat(60));
  
  // Configuration - Use Helius RPC with Light Protocol support
  // Same API key as velvet-rope frontend for consistency
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

  const lightRpc = createRpc(rpcUrl, rpcUrl);
  const swapProgram = anchor.workspace.LightSwapPsp as Program<LightSwapPsp>;
  const authority = provider.wallet.publicKey;

  console.log("\nConfiguration:");
  console.log("  RPC:", rpcUrl.includes("helius") ? "Helius devnet" : "standard devnet");
  console.log("  Authority:", authority.toBase58());
  console.log("  Program ID:", swapProgram.programId.toBase58());
  console.log("  Mint A (wSOL):", DEVNET_WSOL_MINT.toBase58());
  console.log("  Mint B (USDC):", DEVNET_USDC_MINT.toBase58());

  // Derive pool address
  const addressTree = LIGHT_BATCH_ADDRESS_TREE;
  const outputQueue = LIGHT_OUTPUT_QUEUE;
  
  const seeds = [Buffer.from("pool"), DEVNET_WSOL_MINT.toBuffer(), DEVNET_USDC_MINT.toBuffer()];
  const poolAddressSeed = deriveAddressSeedV2(seeds);
  const poolAddress = deriveAddressV2(poolAddressSeed, addressTree, swapProgram.programId);
  
  console.log("\nPool Details:");
  console.log("  Pool Address:", poolAddress.toBase58());
  console.log("  Address Tree:", addressTree.toBase58());
  console.log("  Output Queue:", outputQueue.toBase58());

  // Check if pool already exists
  console.log("\nChecking if pool already exists...");
  try {
    const accounts = await lightRpc.getCompressedAccountsByOwner(swapProgram.programId);
    const existingPool = accounts.items.find((acc: any) => 
      acc.address && Buffer.from(acc.address).equals(poolAddress.toBuffer())
    );
    
    if (existingPool) {
      console.log("✅ Pool already exists! No initialization needed.");
      console.log("   Pool can be used by the frontend immediately.");
      return;
    }
  } catch (e: any) {
    console.log("   Could not check existing pools:", e.message);
  }

  console.log("   Pool not found. Initializing...");

  // Get validity proof for new address
  let proofResult: any;
  try {
    proofResult = await lightRpc.getValidityProofV0(
      [],
      [{
        address: bn(poolAddress.toBytes()),
        tree: addressTree,
        queue: addressTree,
      }]
    );
    console.log("   Got validity proof, rootIndex:", proofResult.rootIndices?.[0]);
  } catch (e: any) {
    console.error("❌ Failed to get validity proof:", e.message);
    throw e;
  }

  // Build remaining accounts
  const packedAccounts = new PackedAccounts();
  const systemAccountConfig = SystemAccountMetaConfig.new(swapProgram.programId);
  packedAccounts.addSystemAccountsV2(systemAccountConfig);
  
  const addressMerkleTreePubkeyIndex = packedAccounts.insertOrGet(addressTree);
  const outputStateTreeIndex = packedAccounts.insertOrGet(outputQueue);
  
  const packedAddressTreeInfo = {
    addressMerkleTreePubkeyIndex,
    addressQueuePubkeyIndex: addressMerkleTreePubkeyIndex,
    rootIndex: proofResult.rootIndices[0],
  };
  
  const { remainingAccounts: rawAccounts } = packedAccounts.toAccountMetas();
  const remainingAccounts = rawAccounts.map((acct: any) => ({
    pubkey: acct.pubkey,
    isWritable: Boolean(acct.isWritable),
    isSigner: Boolean(acct.isSigner),
  }));

  // Format validity proof
  const validityProof = proofResult.compressedProof ? {
    0: {
      a: Array.from(proofResult.compressedProof.a),
      b: Array.from(proofResult.compressedProof.b),
      c: Array.from(proofResult.compressedProof.c),
    }
  } : null;

  // Build and send transaction
  console.log("\nBuilding initialize_pool transaction...");
  try {
    const ix = await swapProgram.methods
      .initializePool(
        validityProof,
        packedAddressTreeInfo,
        outputStateTreeIndex,
        DEVNET_WSOL_MINT,
        DEVNET_USDC_MINT,
        30 // fee_bps (0.3%)
      )
      .accounts({
        feePayer: authority,
        authority: authority,
        incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();
    
    const tx = new anchor.web3.Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
    tx.add(ix);
    
    tx.recentBlockhash = (await lightRpc.getLatestBlockhash()).blockhash;
    tx.feePayer = authority;
    tx.sign(provider.wallet.payer);
    
    console.log("   Sending transaction...");
    const sig = await lightRpc.sendTransaction(tx, [provider.wallet.payer], { skipPreflight: true });
    console.log("   Transaction signature:", sig);
    
    // Wait and check status
    await new Promise(r => setTimeout(r, 3000));
    const status = await connection.getSignatureStatus(sig);
    
    if (status?.value?.err) {
      console.error("❌ Transaction failed:", JSON.stringify(status.value.err));
    } else {
      console.log("\n✅ Pool initialized successfully!");
      console.log("=".repeat(60));
      console.log("PERMANENT POOL CREATED");
      console.log("=".repeat(60));
      console.log("  Pool Address:", poolAddress.toBase58());
      console.log("  Mint A (wSOL):", DEVNET_WSOL_MINT.toBase58());
      console.log("  Mint B (USDC):", DEVNET_USDC_MINT.toBase58());
      console.log("  Fee: 0.3%");
      console.log("  Authority:", authority.toBase58());
      console.log("\nFrontend can now connect and use this pool!");
      console.log("Explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
    }
  } catch (error: any) {
    console.error("❌ Pool initialization failed:", error.message);
    if (error.logs) {
      console.error("Logs:", error.logs.slice(-15).join("\n"));
    }
    throw error;
  }
}

main().catch(console.error);
