/**
 * CSPL Swap Demo Test
 *
 * Demonstrates Inco Confidential SPL Token balance BEFORE and AFTER a swap:
 * 1. Create user accounts for existing devnet mints
 * 2. Mint tokens to user (ECIES encrypted)
 * 3. Read & decrypt balance BEFORE swap
 * 4. Execute swap_exact_in against deployed pool (Light Protocol + Inco Token CPI)
 * 5. Read & decrypt balance AFTER swap
 *
 * Run: npx ts-mocha -p ./tsconfig.json -t 600000 tests/cspl_swap_demo.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  AddressLookupTableProgram,
  Connection,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { expect } from "chai";
import nacl from "tweetnacl";
import { encryptValue } from "@inco/solana-sdk/encryption";
import { decrypt } from "@inco/solana-sdk/attested-decrypt";
import { hexToBuffer } from "@inco/solana-sdk/utils";
import {
  createRpc,
  bn,
  deriveAddressSeedV2,
  deriveAddressV2,
  PackedAccounts,
  SystemAccountMetaConfig,
  featureFlags,
  VERSION,
  batchAddressTree,
  type Rpc,
} from "@lightprotocol/stateless.js";
import * as fs from "fs";
import * as path from "path";

// Force V2 mode for Light Protocol
(featureFlags as any).version = VERSION.V2;

// ─── Constants ─────────────────────────────────────────────────────────

const INCO_LIGHTNING_PROGRAM_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");
const INCO_TOKEN_PROGRAM_ID = new PublicKey("CYVSeUyVzHGVcrxsJt3E8tbaPCQT8ASdRR45g5WxUEW7");
const SWAP_PROGRAM_ID = new PublicKey("4b8jCufu7b4WKXdxFRQHWSks4QdskW62qF7tApSNXuZD");
const LIGHT_BATCH_ADDRESS_TREE = new PublicKey(batchAddressTree);
const LIGHT_OUTPUT_QUEUE = new PublicKey("oq1na8gojfdUhsfCpyjNt6h4JaDWtHf1yQj4koBWfto");
const INPUT_TYPE = 0;

// Devnet config
const devnetConfig = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "devnet-config.json"), "utf8")
);
const INCO_MINT_A = new PublicKey(devnetConfig.incoMintA);
const INCO_MINT_B = new PublicKey(devnetConfig.incoMintB);
const POOL_VAULT_A = new PublicKey(devnetConfig.poolVaultA);
const POOL_VAULT_B = new PublicKey(devnetConfig.poolVaultB);
const POOL_AUTHORITY_PDA = new PublicKey(devnetConfig.poolAuthorityPda);
const LOOKUP_TABLE_ADDRESS = new PublicKey(devnetConfig.lookupTable);

// ─── Helpers ───────────────────────────────────────────────────────────

function extractHandleFromAnchor(anchorHandle: any): bigint {
  if (anchorHandle && anchorHandle._bn) return BigInt(anchorHandle._bn.toString(10));
  if (typeof anchorHandle === "object" && anchorHandle["0"]) {
    const nested = anchorHandle["0"];
    if (nested && nested._bn) return BigInt(nested._bn.toString(10));
    if (nested?.constructor?.name === "BN") return BigInt(nested.toString(10));
  }
  if (anchorHandle instanceof Uint8Array || Array.isArray(anchorHandle)) {
    const buffer = Buffer.from(anchorHandle);
    let result = BigInt(0);
    for (let i = buffer.length - 1; i >= 0; i--) result = result * 256n + BigInt(buffer[i]);
    return result;
  }
  if (typeof anchorHandle === "number" || typeof anchorHandle === "bigint") return BigInt(anchorHandle);
  return 0n;
}

const parseRootIndex = (value: any): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (value?._bn) {
    const parsed = Number(value._bn.toString(10));
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (value?.toString) {
    const parsed = Number(value.toString());
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

const parseBoolFlag = (value: any): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return undefined;
};

function extractHandleFromRaw(data: Buffer): bigint {
  const amountBytes = data.slice(72, 88);
  let handle = 0n;
  for (let i = 15; i >= 0; i--) handle = handle * 256n + BigInt(amountBytes[i]);
  return handle;
}

function getAllowancePda(handle: bigint, allowedAddress: PublicKey): [PublicKey, number] {
  const buf = Buffer.alloc(16);
  let h = handle;
  for (let i = 0; i < 16; i++) { buf[i] = Number(h & 0xffn); h >>= 8n; }
  return PublicKey.findProgramAddressSync([buf, allowedAddress.toBuffer()], INCO_LIGHTNING_PROGRAM_ID);
}

function formatTokens(plaintext: string, decimals: number): string {
  if (!plaintext || plaintext === "DECRYPT_FAILED" || plaintext === "?") return plaintext;
  try {
    const val = BigInt(plaintext);
    const divisor = BigInt(10 ** decimals);
    const whole = val / divisor;
    const frac = val % divisor;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
  } catch { return plaintext; }
}

const encryptAmount = async (amount: bigint) => hexToBuffer(await encryptValue(amount));

const computeBudgetIxs = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
];

async function simulateAndGetHandle(
  connection: Connection, tx: any, signer: Keypair, accountPubkey: PublicKey
): Promise<bigint | null> {
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const sim = await connection.simulateTransaction(tx, undefined, [accountPubkey]);
  if (sim.value.err) return null;
  if (sim.value.accounts?.[0]?.data) {
    return extractHandleFromRaw(Buffer.from(sim.value.accounts[0].data[0], "base64"));
  }
  return null;
}

function derivePoolAddress(mintA: PublicKey, mintB: PublicKey): PublicKey {
  const seeds = [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()];
  return deriveAddressV2(deriveAddressSeedV2(seeds), LIGHT_BATCH_ADDRESS_TREE, SWAP_PROGRAM_ID);
}

function formatValidityProof(compressedProof: any, proveByIndex: boolean = false) {
  if (proveByIndex || !compressedProof) return { 0: null };
  return {
    0: {
      a: Array.from(compressedProof.a),
      b: Array.from(compressedProof.b),
      c: Array.from(compressedProof.c),
    },
  };
}

// ─── Test ──────────────────────────────────────────────────────────────

describe("CSPL Swap Demo — Confidential Token Balance Before & After Swap", function () {
  this.timeout(600000);

  const HELIUS_API_KEY = process.env.HELIUS_DEVNET_API_KEY || "2d8978c6-7067-459f-ae97-7ea035f1a0cb";
  const rpcUrl = `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  process.env.ANCHOR_PROVIDER_URL = rpcUrl;
  process.env.ANCHOR_WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, anchor.AnchorProvider.env().wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load IDLs
  const incoTokenIdl = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "idl/inco_token.json"), "utf8")
  );
  const swapIdl = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "idl/light_swap_psp.json"), "utf8")
  );
  const incoProgram = new Program(incoTokenIdl, provider);
  const swapProgram = new Program(swapIdl, provider);

  const authority = provider.wallet.publicKey;
  const walletKeypair = (provider.wallet as any).payer as Keypair;
  let lightRpc: Rpc;
  let lookupTable: AddressLookupTableAccount | null = null;

  // Fresh user accounts
  const userTokenAKp = Keypair.generate();
  const userTokenBKp = Keypair.generate();

  const SWAP_AMOUNT_IN = BigInt(1_000_000_000); // 1 token A (9 decimals)
  const txHashes: Record<string, string> = {};

  // Track decrypted balances
  let balanceBefore: { tokenA: string; tokenB: string; handleA: string; handleB: string } = { tokenA: "?", tokenB: "?", handleA: "", handleB: "" };
  let balanceAfter = { tokenA: "?", tokenB: "?" };

  async function decryptHandle(handle: string, retries = 8): Promise<string> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      await new Promise((r) => setTimeout(r, 8000 + attempt * 5000));
      try {
        const result = await decrypt([handle], {
          address: walletKeypair.publicKey,
          signMessage: async (msg: Uint8Array) => nacl.sign.detached(msg, walletKeypair.secretKey),
        });
        return result.plaintexts[0] || "0";
      } catch (error: any) {
        const msg = error.message?.slice(0, 120) || "";
        if (attempt < retries && msg.includes("No ciphertext")) {
          console.log(`  Retry ${attempt}/${retries} — waiting for covalidator...`);
          continue;
        }
        console.error(`  Decrypt error (attempt ${attempt}):`, msg);
        if (attempt === retries) return "DECRYPT_FAILED";
      }
    }
    return "DECRYPT_FAILED";
  }

  // ─── Setup ─────────────────────────────────────────────────────────

  it("0. Setup — Verify pool & create user accounts", async () => {
    console.log("\n" + "═".repeat(70));
    console.log("  CSPL SWAP DEMO — Inco Confidential SPL Token Swap");
    console.log("═".repeat(70));
    console.log("\n  Authority:", authority.toBase58());
    console.log("  Mint A:", INCO_MINT_A.toBase58());
    console.log("  Mint B:", INCO_MINT_B.toBase58());
    console.log("  Pool Vault A:", POOL_VAULT_A.toBase58());
    console.log("  Pool Vault B:", POOL_VAULT_B.toBase58());

    // Init Light RPC
    lightRpc = createRpc(rpcUrl, rpcUrl);

    // Fetch lookup table
    const lutResult = await connection.getAddressLookupTable(LOOKUP_TABLE_ADDRESS);
    lookupTable = lutResult.value;
    console.log("  Lookup Table:", lookupTable ? "loaded" : "not found");

    // Verify pool exists
    const poolAddress = derivePoolAddress(INCO_MINT_A, INCO_MINT_B);
    console.log("  Pool Address:", poolAddress.toBase58());

    const accounts = await lightRpc.getCompressedAccountsByOwner(SWAP_PROGRAM_ID);
    const pool = accounts.items.find((acc: any) =>
      acc.address && Buffer.from(acc.address).equals(poolAddress.toBuffer())
    );
    expect(pool, "Pool must exist on devnet").to.not.be.undefined;
    console.log("  ✅ Pool found on devnet");

    // Create user token account A
    console.log("\n  Creating user token account A...");
    const txA = await incoProgram.methods
      .initializeAccount()
      .accounts({
        account: userTokenAKp.publicKey,
        mint: INCO_MINT_A,
        owner: authority,
        payer: authority,
      } as any)
      .preInstructions(computeBudgetIxs())
      .signers([userTokenAKp])
      .rpc();
    console.log("  ✅ User Token A:", userTokenAKp.publicKey.toBase58());

    // Create user token account B
    console.log("  Creating user token account B...");
    const txB = await incoProgram.methods
      .initializeAccount()
      .accounts({
        account: userTokenBKp.publicKey,
        mint: INCO_MINT_B,
        owner: authority,
        payer: authority,
      } as any)
      .preInstructions(computeBudgetIxs())
      .signers([userTokenBKp])
      .rpc();
    console.log("  ✅ User Token B:", userTokenBKp.publicKey.toBase58());
  });

  // ─── Mint ──────────────────────────────────────────────────────────

  it("1. Mint tokens for swap input", async () => {
    console.log("\n" + "─".repeat(70));
    console.log("  STEP 1: Mint 1 token A to user (swap input)");
    console.log("─".repeat(70));

    const ciphertext = await encryptAmount(SWAP_AMOUNT_IN);

    // Simulate to get handle
    const simTx = await incoProgram.methods
      .mintTo(Buffer.from(ciphertext), INPUT_TYPE)
      .accounts({
        mint: INCO_MINT_A,
        account: userTokenAKp.publicKey,
        mintAuthority: authority,
      } as any)
      .transaction();

    const newHandle = await simulateAndGetHandle(connection, simTx, walletKeypair, userTokenAKp.publicKey);
    expect(newHandle).to.not.be.null;
    const [allowancePda] = getAllowancePda(newHandle!, authority);

    // Execute with allowance
    const mintTx = await incoProgram.methods
      .mintTo(Buffer.from(ciphertext), INPUT_TYPE)
      .accounts({
        mint: INCO_MINT_A,
        account: userTokenAKp.publicKey,
        mintAuthority: authority,
      } as any)
      .remainingAccounts([
        { pubkey: allowancePda, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: false },
      ])
      .preInstructions(computeBudgetIxs())
      .rpc();

    txHashes["mint"] = mintTx;
    console.log("  ✅ Mint tx:", mintTx);

    // Also ensure pool vault B has liquidity (mint 100 USDC if empty)
    console.log("\n  Ensuring pool vault B has liquidity...");
    try {
      const vaultBInfo = await connection.getAccountInfo(POOL_VAULT_B, "confirmed");
      if (vaultBInfo) {
        const vaultHandle = extractHandleFromRaw(vaultBInfo.data as Buffer);
        console.log("  Pool Vault B handle:", vaultHandle.toString().slice(0, 20) + "...");
        if (vaultHandle === 0n) {
          console.log("  Vault B empty — minting 100 USDC...");
          const amount = BigInt(100_000_000); // 100 USDC (6 decimals)
          const ct = await encryptAmount(amount);
          await incoProgram.methods
            .mintTo(Buffer.from(ct), INPUT_TYPE)
            .accounts({ mint: INCO_MINT_B, account: POOL_VAULT_B, mintAuthority: authority } as any)
            .preInstructions(computeBudgetIxs())
            .rpc();
          console.log("  ✅ Minted 100 USDC to pool vault B");
        } else {
          console.log("  ✅ Pool Vault B already has liquidity");
        }
      }
    } catch (e: any) {
      console.log("  ⚠ Could not check vault B:", e.message?.slice(0, 80));
    }
  });

  // ─── Balance BEFORE ────────────────────────────────────────────────

  it("2. Read & decrypt balance BEFORE swap", async () => {
    console.log("\n" + "─".repeat(70));
    console.log("  STEP 2: CSPL Balance BEFORE Swap");
    console.log("─".repeat(70));
    console.log("  Waiting for covalidator...");
    await new Promise((r) => setTimeout(r, 5000));

    // Token A
    const acctA = await incoProgram.account.incoAccount.fetch(userTokenAKp.publicKey);
    const handleA = extractHandleFromAnchor(acctA.amount);
    console.log("\n  User Token A handle:", handleA.toString().slice(0, 30) + "...");
    const plainA = await decryptHandle(handleA.toString());
    balanceBefore.tokenA = plainA;
    balanceBefore.handleA = handleA.toString();
    console.log("  ┌──────────────────────────────────────────────────┐");
    console.log(`  │  TOKEN A BALANCE (BEFORE): ${formatTokens(plainA, 9)} tokens      │`);
    console.log("  └──────────────────────────────────────────────────┘");

    // Token B
    const acctB = await incoProgram.account.incoAccount.fetch(userTokenBKp.publicKey);
    const handleB = extractHandleFromAnchor(acctB.amount);
    balanceBefore.handleB = handleB.toString();
    console.log("\n  User Token B handle:", handleB.toString().slice(0, 30) + "...");
    console.log("  ┌──────────────────────────────────────────────────┐");
    console.log("  │  TOKEN B BALANCE (BEFORE): 0 tokens              │");
    console.log("  └──────────────────────────────────────────────────┘");
    balanceBefore.tokenB = "0";
  });

  // ─── Swap ──────────────────────────────────────────────────────────

  it("3. Execute swap_exact_in (A → B)", async () => {
    console.log("\n" + "─".repeat(70));
    console.log("  STEP 3: Execute Swap — 1 Token A → Token B");
    console.log("─".repeat(70));

    // Fund pool_authority PDA so it can pay rent for allowance PDAs during transfer_out
    // Pool authority needs to create 2 allowance PDAs (~960K each) + stay rent-exempt
    const poolAuthBalance = await connection.getBalance(POOL_AUTHORITY_PDA);
    const rentNeeded = 5_000_000; // ~0.005 SOL for 2 allowance PDAs + buffer
    if (poolAuthBalance < rentNeeded) {
      console.log(`  Funding pool_authority PDA (current: ${poolAuthBalance}, need: ${rentNeeded})...`);
      const fundTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority,
          toPubkey: POOL_AUTHORITY_PDA,
          lamports: rentNeeded - poolAuthBalance,
        })
      );
      fundTx.feePayer = authority;
      fundTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      fundTx.sign(walletKeypair);
      const fundSig = await connection.sendRawTransaction(fundTx.serialize());
      await connection.confirmTransaction(fundSig, "confirmed");
      console.log("  ✅ Pool authority funded");
    }

    // Compute swap quote (constant product)
    const reserveA = 1000_000_000_000n; // estimated 1000 wSOL
    const reserveB = 100_000_000_000n;  // estimated 100k USDC
    const feeBps = 30n;
    const feeAmount = (SWAP_AMOUNT_IN * feeBps) / 10000n;
    const netIn = SWAP_AMOUNT_IN - feeAmount;
    const amountOut = (reserveB * netIn) / (reserveA + netIn);
    console.log("  Amount In:", SWAP_AMOUNT_IN.toString(), "(1 token A)");
    console.log("  Fee:", feeAmount.toString());
    console.log("  Amount Out:", amountOut.toString(), "(token B)");

    // Encrypt all 3 amounts
    console.log("\n  Encrypting amounts (ECIES)...");
    const amountInCiphertext = await encryptAmount(SWAP_AMOUNT_IN);
    const amountOutCiphertext = await encryptAmount(amountOut);
    const feeAmountCiphertext = await encryptAmount(feeAmount);
    console.log("  Ciphertext sizes:", amountInCiphertext.length, amountOutCiphertext.length, feeAmountCiphertext.length, "bytes");

    // Fetch pool state
    console.log("\n  Fetching pool compressed state...");
    const poolAddress = derivePoolAddress(INCO_MINT_A, INCO_MINT_B);
    let poolAccount = await lightRpc.getCompressedAccount(bn(poolAddress.toBytes()));
    if (!poolAccount) {
      const compressedAccounts = await lightRpc.getCompressedAccountsByOwner(SWAP_PROGRAM_ID);
      poolAccount = compressedAccounts.items.find((acc: any) =>
        acc.address && Buffer.from(acc.address).equals(poolAddress.toBuffer())
      );
    }
    expect(poolAccount, "Pool must exist").to.not.be.undefined;

    const acct = poolAccount as any;
    const treeInfo = acct.treeInfo || {};
    const leafIndex = acct.leafIndex || 0;
    const accountHash = acct.hash;
    const stateTree = new PublicKey(treeInfo.tree);
    const stateQueue = new PublicKey(treeInfo.queue);
    const rawPoolData = acct.data?.data;
    const poolDataInput =
      rawPoolData && typeof rawPoolData === "object" && !Array.isArray(rawPoolData) && !Buffer.isBuffer(rawPoolData)
        ? (rawPoolData as any).data ?? rawPoolData
        : rawPoolData;
    const poolData =
      typeof poolDataInput === "string"
        ? Buffer.from(poolDataInput, "base64")
        : poolDataInput instanceof Uint8Array || Array.isArray(poolDataInput)
          ? Buffer.from(poolDataInput)
          : Buffer.from(poolDataInput || []);
    let acctRootIndex = parseRootIndex((acct as any).rootIndex);
    let acctProveByIndex = parseBoolFlag((acct as any).proveByIndex);
    const treeRootIndex = parseRootIndex(treeInfo.rootIndex) ?? acctRootIndex;
    const treeProveByIndex = parseBoolFlag((treeInfo as any).proveByIndex);

    console.log("  Pool tree:", stateTree.toBase58());
    console.log("  Pool queue:", stateQueue.toBase58());
    console.log("  Pool leaf index:", leafIndex);
    console.log("  Pool tree root index:", treeRootIndex ?? "(unknown)");
    console.log("  Pool proveByIndex:", acctProveByIndex ?? treeProveByIndex ?? "(unknown)");
    console.log("  Pool hash ctor:", (accountHash as any)?.constructor?.name ?? "(unknown)");
    console.log(
      "  Pool data type:",
      typeof poolDataInput,
      "len:",
      poolData.length
    );

    // Get validity proof
    console.log("  Fetching validity proof...");
    const hashInput = (() => {
      if (accountHash instanceof Uint8Array || Array.isArray(accountHash)) {
        return bn(accountHash);
      }
      if (accountHash?.toArrayLike) {
        return accountHash;
      }
      return bn(accountHash as any);
    })();
    console.log("  Pool hash type:", typeof accountHash, "bn?");

    if (acctRootIndex == null || acctProveByIndex == null) {
      const compressedAccount = await lightRpc.getCompressedAccount(undefined, hashInput as any);
      const caRoot = parseRootIndex((compressedAccount as any)?.rootIndex);
      const caProveByIndex = parseBoolFlag((compressedAccount as any)?.proveByIndex);
      if (caRoot != null) {
        acctRootIndex = caRoot;
      }
      if (caProveByIndex != null) {
        acctProveByIndex = caProveByIndex;
      }
      if (caRoot != null || caProveByIndex != null) {
        console.log("  CompressedAccount rootIndex:", caRoot, "proveByIndex:", caProveByIndex);
      }
    }
    let proofRootIndex: number | undefined;
    let accountProofProveByIndex: boolean | undefined;
    let proveByIndex =
      parseBoolFlag((acct as any).proveByIndex) ??
      parseBoolFlag((treeInfo as any).proveByIndex) ??
      false;
    let compressedProof: any = null;
    try {
      const accountProof = await lightRpc.getCompressedAccountProof(hashInput);
      const accountProofRoot = parseRootIndex((accountProof as any)?.rootIndex);
      accountProofProveByIndex = parseBoolFlag((accountProof as any)?.proveByIndex);
      if (accountProofRoot != null) {
        proofRootIndex = accountProofRoot;
      }
      if (accountProofProveByIndex != null) {
        proveByIndex = accountProofProveByIndex;
      }
      if (accountProofRoot != null || accountProofProveByIndex != null) {
        console.log(
          "  CompressedAccountProof rootIndex:",
          accountProofRoot,
          "proveByIndex:",
          accountProofProveByIndex
        );
      }
    } catch (error: any) {
      console.log("  getCompressedAccountProof failed:", error?.message ?? error);
    }

    const proofResult = await lightRpc.getValidityProofV0(
      [{ hash: hashInput, tree: stateTree, queue: stateQueue }],
      []
    );
    const rootIndexRaw = proofResult.rootIndices?.[0];
    const rootIndexFromProof =
      parseRootIndex(rootIndexRaw) ?? parseRootIndex((rootIndexRaw as any)?.rootIndex);
    let rootIndex = proofRootIndex ?? rootIndexFromProof ?? treeRootIndex ?? 0;
    if (proofResult.compressedProof) {
      compressedProof = proofResult.compressedProof;
    }
    const proofProveByIndex = parseBoolFlag((rootIndexRaw as any)?.proveByIndex);
    if (proofProveByIndex != null && accountProofProveByIndex == null) {
      proveByIndex = proofProveByIndex;
    }
    if (accountProofProveByIndex == null) {
      if (typeof acctProveByIndex === "boolean") {
        proveByIndex = acctProveByIndex;
      } else if (typeof treeProveByIndex === "boolean") {
        proveByIndex = treeProveByIndex;
      }
    }
    if (rootIndex === 0) {
      console.log("  Root index from getValidityProofV0 is 0 — trying getMultipleCompressedAccountProofs...");
      const altProofs = await lightRpc.getMultipleCompressedAccountProofs([hashInput]);
      const altProof = altProofs?.[0];
      if (altProof?.rootIndex != null) {
        rootIndex = altProof.rootIndex;
      }
      if (typeof altProof?.proveByIndex === "boolean") {
        proveByIndex = altProof.proveByIndex;
      }
    }
    if (rootIndex === 0) {
      console.log("  Root index still 0 — retrying getValidityProofV0 with LIGHT_OUTPUT_QUEUE...");
      const altProofResult = await lightRpc.getValidityProofV0(
        [{ hash: hashInput, tree: stateTree, queue: LIGHT_OUTPUT_QUEUE }],
        []
      );
      const altRootRaw = altProofResult.rootIndices?.[0];
      const altRootIndex =
        typeof altRootRaw === "number"
          ? altRootRaw
          : (altRootRaw as any)?.rootIndex;
      if (altRootIndex != null) {
        rootIndex = altRootIndex;
      }
      if (typeof (altRootRaw as any)?.proveByIndex === "boolean") {
        proveByIndex = (altRootRaw as any).proveByIndex;
      }
      if (!proveByIndex && altProofResult.compressedProof) {
        // Override compressed proof when proving by merkle proof
        (compressedProof as any) = altProofResult.compressedProof;
      }
    }

    if (rootIndex === 0) {
      console.log("  Root index still 0 — trying getCompressedAccountProof...");
      const singleProof = await lightRpc.getCompressedAccountProof(hashInput);
      if (singleProof?.rootIndex != null) {
        rootIndex = singleProof.rootIndex;
      }
      const singleProveByIndex = parseBoolFlag((singleProof as any)?.proveByIndex);
      if (singleProveByIndex != null) {
        proveByIndex = singleProveByIndex;
      }
    }
    if (!compressedProof && !proveByIndex) {
      console.log("  No compressed proof yet — trying getValidityProof (non-V0)...");
      const legacyProof = await (lightRpc as any).getValidityProof([hashInput], []);
      const legacyRootRaw = legacyProof?.rootIndices?.[0];
      const legacyRootIndex =
        typeof legacyRootRaw === "number"
          ? legacyRootRaw
          : (legacyRootRaw as any)?.rootIndex;
      if (rootIndex === 0 && legacyRootIndex != null) {
        rootIndex = legacyRootIndex;
      }
      if (legacyProof?.compressedProof) {
        compressedProof = legacyProof.compressedProof;
        proveByIndex = false;
      } else {
        const legacyProveByIndex = parseBoolFlag((legacyRootRaw as any)?.proveByIndex);
        if (legacyProveByIndex != null && accountProofProveByIndex == null) {
          proveByIndex = legacyProveByIndex;
        }
      }
    }
    if (proofRootIndex != null) {
      rootIndex = proofRootIndex;
    } else if (acctRootIndex != null && acctRootIndex !== 0 && rootIndex === 0) {
      rootIndex = acctRootIndex;
    }
    if (accountProofProveByIndex != null) {
      proveByIndex = accountProofProveByIndex;
    }
    console.log(
      "  Root index:",
      rootIndex,
      "(proveByIndex:",
      proveByIndex + ")",
      "proof:",
      compressedProof ? "present" : "null"
    );
    if (rootIndex === 0 && treeRootIndex && treeRootIndex !== 0) {
      console.log("  ⚠ Using rootIndex=0 despite treeInfo.rootIndex=", treeRootIndex);
    }
    if (!proveByIndex && !compressedProof) {
      throw new Error("Missing compressed proof while proveByIndex=false");
    }

    // Build packed accounts
    const packedAccounts = new PackedAccounts();
    packedAccounts.addSystemAccountsV2(SystemAccountMetaConfig.new(SWAP_PROGRAM_ID));
    const stateTreeIndex = packedAccounts.insertOrGet(stateTree);
    const stateQueueIndex = packedAccounts.insertOrGet(stateQueue);
    const outputStateTreeIndex = packedAccounts.insertOrGet(LIGHT_OUTPUT_QUEUE);
    packedAccounts.insertOrGet(LIGHT_BATCH_ADDRESS_TREE);
    const { remainingAccounts: rawAccounts } = packedAccounts.toAccountMetas();
    const remainingAccounts = rawAccounts.map((a: any) => ({
      pubkey: a.pubkey,
      isWritable: Boolean(a.isWritable),
      isSigner: Boolean(a.isSigner),
    }));

    const poolMeta = {
      treeInfo: {
        rootIndex,
        proveByIndex,
        merkleTreePubkeyIndex: stateTreeIndex,
        queuePubkeyIndex: stateQueueIndex,
        leafIndex,
      },
      address: Array.from(poolAddress.toBytes()),
      outputStateTreeIndex: outputStateTreeIndex,
    };

    const validityProof = formatValidityProof(compressedProof, proveByIndex);

    // === STEP A: Build swap instruction WITHOUT allowances for SIMULATION ===
    console.log("\n  Building swap instruction (for simulation)...");
    const swapAccounts = {
      feePayer: authority,
      poolAuthority: POOL_AUTHORITY_PDA,
      userTokenA: userTokenAKp.publicKey,
      userTokenB: userTokenBKp.publicKey,
      poolVaultA: POOL_VAULT_A,
      poolVaultB: POOL_VAULT_B,
      incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
      incoTokenProgram: INCO_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };

    const simIx = await swapProgram.methods
      .swapExactIn(
        validityProof,
        poolMeta,
        poolData,
        Buffer.from(amountInCiphertext),
        Buffer.from(amountOutCiphertext),
        Buffer.from(feeAmountCiphertext),
        INPUT_TYPE,
        true, // a_to_b
        0,    // num_allowance_accounts = 0 for simulation
      )
      .accounts(swapAccounts as any)
      .remainingAccounts(remainingAccounts)
      .instruction();

    // Build V0 VersionedTransaction for simulation (unsigned)
    const { blockhash: simBlockhash } = await connection.getLatestBlockhash();
    const simMsg = new TransactionMessage({
      payerKey: authority,
      recentBlockhash: simBlockhash,
      instructions: [...computeBudgetIxs(), simIx],
    }).compileToV0Message([lookupTable!]);
    const simVtx = new VersionedTransaction(simMsg);

    // Simulate to get post-transfer account states
    console.log("  Simulating swap to extract post-transfer handles...");
    const simResult = await connection.simulateTransaction(simVtx, {
      sigVerify: false,
      accounts: {
        encoding: "base64" as const,
        addresses: [
          userTokenAKp.publicKey.toBase58(),  // user_token_in (a_to_b)
          userTokenBKp.publicKey.toBase58(),  // user_token_out
          POOL_VAULT_A.toBase58(),            // pool_vault_in
          POOL_VAULT_B.toBase58(),            // pool_vault_out
        ],
      },
    });

    if (simResult.value.err) {
      console.log("  ⚠ Simulation error:", JSON.stringify(simResult.value.err));
      if (simResult.value.logs) {
        console.log("  Sim logs (last 10):");
        simResult.value.logs.slice(-10).forEach((l: string) => console.log("    " + l));
      }
    }

    // Extract handles from simulated account states
    function extractHandleFromBase64(b64Data: string): bigint {
      const data = Buffer.from(b64Data, "base64");
      const amountBytes = data.slice(72, 88);
      let handle = BigInt(0);
      for (let i = 15; i >= 0; i--) {
        handle = handle * BigInt(256) + BigInt(amountBytes[i]);
      }
      return handle;
    }

    const simAccounts = simResult.value.accounts || [];
    const userInHandle = simAccounts[0]?.data ? extractHandleFromBase64((simAccounts[0].data as any)[0]) : 0n;
    const userOutHandle = simAccounts[1]?.data ? extractHandleFromBase64((simAccounts[1].data as any)[0]) : 0n;
    const poolOutHandle = simAccounts[3]?.data ? extractHandleFromBase64((simAccounts[3].data as any)[0]) : 0n;

    console.log("  User  IN handle (post-sim):", userInHandle.toString().slice(0, 30) + "...");
    console.log("  User OUT handle (post-sim):", userOutHandle.toString().slice(0, 30) + "...");
    console.log("  Pool OUT handle (post-sim):", poolOutHandle.toString().slice(0, 30) + "...");

    // Derive allowance PDAs
    const [userInPda] = getAllowancePda(userInHandle, authority);
    const [poolOutPda] = getAllowancePda(poolOutHandle, POOL_AUTHORITY_PDA);
    const [userOutPda] = getAllowancePda(userOutHandle, authority);
    console.log("  Allowance PDAs derived ✅");

    // Extend LUT with allowance PDAs to keep swap tx size under limit
    if (!lookupTable) {
      throw new Error("Lookup table missing; cannot extend for allowance PDAs");
    }
    const lutSet = new Set(lookupTable.state.addresses.map((a) => a.toBase58()));
    const newLutAddrs = [userInPda, poolOutPda, userOutPda].filter(
      (a) => !lutSet.has(a.toBase58())
    );
    if (newLutAddrs.length > 0) {
      console.log(`  Extending LUT with ${newLutAddrs.length} allowance accounts...`);
      const extendIx = AddressLookupTableProgram.extendLookupTable({
        lookupTable: LOOKUP_TABLE_ADDRESS,
        authority,
        payer: authority,
        addresses: newLutAddrs,
      });
      const extendTx = new anchor.web3.Transaction().add(extendIx);
      extendTx.feePayer = authority;
      extendTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      extendTx.sign(walletKeypair);
      const extendSig = await connection.sendRawTransaction(extendTx.serialize(), { skipPreflight: true });
      await connection.confirmTransaction(extendSig, "confirmed");
      const lutResult = await connection.getAddressLookupTable(LOOKUP_TABLE_ADDRESS);
      lookupTable = lutResult.value;
      if (!lookupTable) throw new Error("Failed to reload lookup table after extend");
    }

    // === STEP B: Build swap instruction WITH allowances for EXECUTION ===
    // 6 allowance accounts: [userInPda, user, poolOutPda, poolAuth, userOutPda, user]
    const allowanceAccounts = [
      { pubkey: userInPda, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: poolOutPda, isSigner: false, isWritable: true },
      { pubkey: POOL_AUTHORITY_PDA, isSigner: false, isWritable: false },
      { pubkey: userOutPda, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
    ];

    console.log("\n  Building swap instruction (with allowances)...");
    const ix = await swapProgram.methods
      .swapExactIn(
        validityProof,
        poolMeta,
        poolData,
        Buffer.from(amountInCiphertext),
        Buffer.from(amountOutCiphertext),
        Buffer.from(feeAmountCiphertext),
        INPUT_TYPE,
        true, // a_to_b
        6,    // num_allowance_accounts = 6
      )
      .accounts(swapAccounts as any)
      .remainingAccounts([...remainingAccounts, ...allowanceAccounts])
      .instruction();

    // Build V0 transaction with lookup table
    const allIxs = [...computeBudgetIxs(), ix];
    const { blockhash } = await connection.getLatestBlockhash();

    let swapSig: string;
    console.log("  Using V0 VersionedTransaction with lookup table");
    const messageV0 = new TransactionMessage({
      payerKey: authority,
      recentBlockhash: blockhash,
      instructions: allIxs,
    }).compileToV0Message([lookupTable!]);
    const vTx = new VersionedTransaction(messageV0);
    vTx.sign([walletKeypair]);
    swapSig = await connection.sendRawTransaction(vTx.serialize(), { skipPreflight: true });

    console.log("\n  ⏳ Waiting for confirmation...");
    const confirmation = await connection.confirmTransaction(swapSig, "confirmed");
    if (confirmation.value.err) {
      const txInfo = await connection.getTransaction(swapSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      console.log("  ❌ SWAP TX FAILED ON-CHAIN:", JSON.stringify(confirmation.value.err));
      if (txInfo?.meta?.logMessages) {
        const logs = txInfo.meta.logMessages;
        console.log("  Logs (swap stages):");
        logs
          .filter((l: string) =>
            l.includes("swap_exact_in") ||
            l.includes("compute_swap_updates") ||
            l.includes("Program 4b8jCufu7b4WKXdxFRQHWSks4QdskW62qF7tApSNXuZD") ||
            l.includes("failed")
          )
          .forEach((l: string) => console.log("    " + l));
        console.log("  Logs (last 80):");
        logs.slice(-80).forEach((l: string) => console.log("    " + l));
      }
      throw new Error("Swap TX failed on-chain: " + JSON.stringify(confirmation.value.err));
    }

    txHashes["swap"] = swapSig;
    console.log("  ✅ SWAP TX:", swapSig);
    console.log("  https://explorer.solana.com/tx/" + swapSig + "?cluster=devnet");
  });

  // ─── Balance AFTER ─────────────────────────────────────────────────

  it("4. Decrypt AFTER swap (allowances created atomically)", async function () {
    if (!txHashes["swap"]) {
      this.skip();
    }
    console.log("\n" + "─".repeat(70));
    console.log("  STEP 4: Decrypt post-swap balances");
    console.log("─".repeat(70));

    // Allowance PDAs were created atomically during the swap (via CPI remaining_accounts).
    // Just wait for covalidator to process the FHE operations, then decrypt directly.
    console.log("  ⏳ Waiting 90s for covalidator to process swap FHE ops...");
    await new Promise((r) => setTimeout(r, 90_000));

    // Read post-swap handles
    const acctA = await connection.getAccountInfo(userTokenAKp.publicKey, "confirmed");
    const acctB = await connection.getAccountInfo(userTokenBKp.publicKey, "confirmed");
    const handleAAfter = acctA ? extractHandleFromRaw(acctA.data as Buffer) : 0n;
    const handleBAfter = acctB ? extractHandleFromRaw(acctB.data as Buffer) : 0n;

    console.log("\n  Token A handle BEFORE:", balanceBefore.handleA?.slice(0, 30) + "...");
    console.log("  Token A handle AFTER: ", handleAAfter.toString().slice(0, 30) + "...");
    console.log("  → Handle CHANGED:", balanceBefore.handleA !== handleAAfter.toString() ? "✅ YES" : "❌ NO");
    console.log("\n  Token B handle BEFORE:", balanceBefore.handleB?.slice(0, 30) + "...");
    console.log("  Token B handle AFTER: ", handleBAfter.toString().slice(0, 30) + "...");
    console.log("  → Handle CHANGED:", balanceBefore.handleB !== handleBAfter.toString() ? "✅ YES" : "❌ NO");

    // Decrypt directly — allowances were granted during swap
    console.log("\n  Decrypting post-swap balances...");
    const plainA = await decryptHandle(handleAAfter.toString());
    balanceAfter.tokenA = plainA;
    console.log("  ┌──────────────────────────────────────────────────┐");
    console.log(`  │  TOKEN A BALANCE (AFTER): ${formatTokens(plainA, 9)} tokens      │`);
    console.log("  └──────────────────────────────────────────────────┘");

    const plainB = await decryptHandle(handleBAfter.toString());
    balanceAfter.tokenB = plainB;
    console.log("  ┌──────────────────────────────────────────────────┐");
    console.log(`  │  TOKEN B BALANCE (AFTER): ${formatTokens(plainB, 6)} tokens      │`);
    console.log("  └──────────────────────────────────────────────────┘");

    // Verify handles changed from pre-swap
    expect(balanceBefore.handleA).to.not.equal(handleAAfter.toString());
    expect(balanceBefore.handleB).to.not.equal(handleBAfter.toString());
  });

  // ─── Summary ───────────────────────────────────────────────────────

  it("5. Summary — Swap tx hash + balance change", async () => {
    console.log("\n" + "═".repeat(70));
    console.log("  SUMMARY — CSPL Swap Results");
    console.log("═".repeat(70));
    console.log("\n  SWAP TX:", txHashes["swap"]);
    console.log("  Explorer: https://explorer.solana.com/tx/" + txHashes["swap"] + "?cluster=devnet");
    console.log("\n  Balance Changes:");
    console.log("  ┌────────────┬──────────────────┬──────────────────┐");
    console.log("  │   Token    │   BEFORE Swap    │   AFTER Swap     │");
    console.log("  ├────────────┼──────────────────┼──────────────────┤");
    console.log(`  │  Token A   │  ${formatTokens(balanceBefore.tokenA, 9).padEnd(16)} │  ${formatTokens(balanceAfter.tokenA, 9).padEnd(16)} │`);
    console.log(`  │  Token B   │  ${balanceBefore.tokenB.padEnd(16)} │  ${formatTokens(balanceAfter.tokenB, 6).padEnd(16)} │`);
    console.log("  └────────────┴──────────────────┴──────────────────┘");
    console.log("\n  Accounts:");
    console.log("  User Token A:", userTokenAKp.publicKey.toBase58());
    console.log("  User Token B:", userTokenBKp.publicKey.toBase58());
    console.log("═".repeat(70));
  });
});
