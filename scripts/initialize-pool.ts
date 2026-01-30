/**
 * Initialize Light Protocol Pool for Inco Token Swap
 * 
 * This creates the compressed pool state in Light Protocol
 * that tracks reserves and enables swaps.
 * 
 * Usage: npx ts-node scripts/initialize-pool.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
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
import * as fs from "fs";
import * as path from "path";
import { LightSwapPsp } from "../target/types/light_swap_psp";

// Force V2 mode
(featureFlags as any).version = VERSION.V2;

// Load config
const CONFIG_PATH = path.join(__dirname, "../devnet-config.json");

interface DevnetConfig {
  incoMintA: string;
  incoMintB: string;
  poolVaultA: string;
  poolVaultB: string;
  poolAuthorityPda: string;
  incoTokenProgram: string;
  incoLightningProgram: string;
  swapProgram: string;
}

// Light Protocol constants
const LIGHT_BATCH_ADDRESS_TREE = new PublicKey(batchAddressTree);
const LIGHT_OUTPUT_QUEUE = new PublicKey("oq1na8gojfdUhsfCpyjNt6h4JaDWtHf1yQj4koBWfto");
const INCO_LIGHTNING_PROGRAM_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

async function main() {
  console.log("=".repeat(60));
  console.log("Initialize Light Protocol Pool");
  console.log("=".repeat(60));

  // Load config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ Config not found. Run setup-devnet-accounts.ts first.");
    process.exit(1);
  }
  const config: DevnetConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

  // Setup connection and provider
  // Light Protocol requires Helius RPC which exposes both Solana and Photon endpoints
  if (!process.env.HELIUS_DEVNET_API_KEY) {
    console.error("❌ HELIUS_DEVNET_API_KEY is required for Light Protocol");
    console.error("   Get a free key at: https://dev.helius.xyz/");
    process.exit(1);
  }
  const rpcUrl = `https://devnet.helius-rpc.com?api-key=${process.env.HELIUS_DEVNET_API_KEY}`;
  
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = anchor.AnchorProvider.env().wallet;
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const authority = wallet.publicKey;
  console.log("\nAuthority:", authority.toBase58());

  // Load swap program
  const swapProgram = anchor.workspace.LightSwapPsp as Program<LightSwapPsp>;
  console.log("Swap Program:", swapProgram.programId.toBase58());

  // Initialize Light RPC - Helius exposes both Solana and Photon through same URL
  const lightRpc = createRpc(rpcUrl, rpcUrl);
  console.log("Light RPC initialized with Helius");

  const mintA = new PublicKey(config.incoMintA);
  const mintB = new PublicKey(config.incoMintB);

  console.log("\nPool Mints:");
  console.log("  Mint A:", mintA.toBase58());
  console.log("  Mint B:", mintB.toBase58());

  // Derive pool address using Light Protocol V2
  const addressTree = new PublicKey(batchAddressTree);
  const seeds = [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()];
  const poolAddressSeed = deriveAddressSeedV2(seeds);
  const poolAddress = deriveAddressV2(poolAddressSeed, addressTree, swapProgram.programId);
  console.log("\nPool Address:", poolAddress.toBase58());

  // Check if pool already exists
  try {
    const accounts = await lightRpc.getCompressedAccountsByOwner(swapProgram.programId);
    const existingPool = accounts.items.find((acc: any) => {
      const addr = new PublicKey(acc.address);
      return addr.equals(poolAddress);
    });
    
    if (existingPool) {
      console.log("\n✅ Pool already initialized!");
      console.log("   Leaf index:", existingPool.leafIndex);
      return;
    }
  } catch (e) {
    console.log("No existing pool found, proceeding with initialization...");
  }

  // Get validity proof from Light RPC for the new address
  console.log("\nGetting validity proof from Light RPC...");
  
  let proofResult: any;
  try {
    proofResult = await lightRpc.getValidityProofV0(
      [], // No existing hashes (creating new)
      [{
        address: bn(poolAddress.toBytes()),
        tree: addressTree,
        queue: addressTree, // Same as tree per Light Protocol example
      }]
    );
    console.log("Got validity proof, rootIndex:", proofResult.rootIndices?.[0]);
  } catch (e: any) {
    console.error("Failed to get validity proof:", e.message);
    throw e;
  }

  // Build remaining accounts
  const packedAccounts = new PackedAccounts();
  packedAccounts.addSystemAccountsV2(SystemAccountMetaConfig.new(swapProgram.programId));
  const addressTreeIndex = packedAccounts.insertOrGet(addressTree);
  const outputQueueIndex = packedAccounts.insertOrGet(LIGHT_OUTPUT_QUEUE);
  
  const accountMetas = packedAccounts.toAccountMetas();
  const remainingAccounts = accountMetas.remainingAccounts.map(acct => ({
    pubkey: acct.pubkey,
    isWritable: Boolean(acct.isWritable),
    isSigner: Boolean(acct.isSigner),
  }));

  // Build proof in the format expected by the program (ValidityProof = Option<CompressedProof>)
  const validityProof = proofResult.compressedProof ? {
    0: {
      a: Array.from(proofResult.compressedProof.a),
      b: Array.from(proofResult.compressedProof.b),
      c: Array.from(proofResult.compressedProof.c),
    }
  } : { 0: null };

  console.log("Validity proof:", validityProof[0] ? "present" : "null");

  // Address tree info
  const addressTreeInfo = {
    addressMerkleTreePubkeyIndex: addressTreeIndex,
    addressQueuePubkeyIndex: addressTreeIndex,
    rootIndex: proofResult.rootIndices[0],
  };

  console.log("\nInitializing pool...");
  console.log("  Address tree index:", addressTreeIndex);
  console.log("  Output queue index:", outputQueueIndex);

  const computeBudgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  ];

  try {
    const ix = await swapProgram.methods
      .initializePool(
        validityProof as any,
        addressTreeInfo,
        outputQueueIndex,
        mintA,
        mintB,
        30 // 0.3% fee
      )
      .accounts({
        feePayer: authority,
        authority: authority,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    const tx = new Transaction();
    tx.add(...computeBudgetIxs);
    tx.add(ix);

    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = authority;

    // Sign and send
    const signedTx = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: true,
    });
    
    console.log("\nTransaction sent:", sig);
    
    // Wait for confirmation
    await connection.confirmTransaction(sig, "confirmed");
    console.log("✅ Pool initialized successfully!");

    // Verify
    const status = await connection.getSignatureStatus(sig);
    if (status?.value?.err) {
      console.error("Transaction error:", status.value.err);
    }

  } catch (e: any) {
    console.error("\n❌ Pool initialization failed:", e.message);
    if (e.logs) {
      console.error("Logs:", e.logs.slice(-10));
    }
    throw e;
  }
}

main().catch(console.error);
