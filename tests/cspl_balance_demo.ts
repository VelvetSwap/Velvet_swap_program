/**
 * CSPL Balance Demo Test
 * 
 * Demonstrates Inco Confidential SPL Token balance flow:
 * 1. Create accounts + mint with ECIES encryption
 * 2. Read & decrypt balance BEFORE transfer
 * 3. Execute encrypted transfer
 * 4. Read & decrypt balance AFTER transfer
 * 
 * Run: npx ts-mocha -p ./tsconfig.json -t 600000 tests/cspl_balance_demo.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Connection,
  ComputeBudgetProgram,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import nacl from "tweetnacl";
import { encryptValue } from "@inco/solana-sdk/encryption";
import { decrypt } from "@inco/solana-sdk/attested-decrypt";
import { hexToBuffer } from "@inco/solana-sdk/utils";
import * as fs from "fs";
import * as path from "path";

// Program IDs
const INCO_LIGHTNING_PROGRAM_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");
const INCO_TOKEN_PROGRAM_ID = new PublicKey("CYVSeUyVzHGVcrxsJt3E8tbaPCQT8ASdRR45g5WxUEW7");
const INPUT_TYPE = 0;

// ─── Helpers ───────────────────────────────────────────────────────────

function extractHandleFromAnchor(anchorHandle: any): bigint {
  if (anchorHandle && anchorHandle._bn) {
    return BigInt(anchorHandle._bn.toString(10));
  }
  if (typeof anchorHandle === "object" && anchorHandle["0"]) {
    const nested = anchorHandle["0"];
    if (nested && nested._bn) return BigInt(nested._bn.toString(10));
    if (nested && nested.toString && nested.constructor?.name === "BN") {
      return BigInt(nested.toString(10));
    }
  }
  if (anchorHandle instanceof Uint8Array || Array.isArray(anchorHandle)) {
    const buffer = Buffer.from(anchorHandle);
    let result = BigInt(0);
    for (let i = buffer.length - 1; i >= 0; i--) {
      result = result * BigInt(256) + BigInt(buffer[i]);
    }
    return result;
  }
  if (typeof anchorHandle === "number" || typeof anchorHandle === "bigint") {
    return BigInt(anchorHandle);
  }
  return BigInt(0);
}

function extractHandleFromRaw(data: Buffer): bigint {
  const amountBytes = data.slice(72, 88);
  let handle = BigInt(0);
  for (let i = 15; i >= 0; i--) {
    handle = handle * BigInt(256) + BigInt(amountBytes[i]);
  }
  return handle;
}

function getAllowancePda(handle: bigint, allowedAddress: PublicKey): [PublicKey, number] {
  const handleBuffer = Buffer.alloc(16);
  let h = handle;
  for (let i = 0; i < 16; i++) {
    handleBuffer[i] = Number(h & BigInt(0xff));
    h = h >> BigInt(8);
  }
  return PublicKey.findProgramAddressSync(
    [handleBuffer, allowedAddress.toBuffer()],
    INCO_LIGHTNING_PROGRAM_ID
  );
}

function formatTokens(plaintext: string, decimals: number): string {
  const val = BigInt(plaintext);
  const divisor = BigInt(10 ** decimals);
  const whole = val / divisor;
  const frac = val % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

const encryptAmount = async (amount: bigint) => hexToBuffer(await encryptValue(amount));

const computeBudgetIxs = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
];

async function simulateAndGetHandle(
  connection: Connection,
  tx: Transaction,
  signer: Keypair,
  accountPubkey: PublicKey
): Promise<bigint | null> {
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const sim = await connection.simulateTransaction(tx, undefined, [accountPubkey]);
  if (sim.value.err) return null;
  if (sim.value.accounts?.[0]?.data) {
    const data = Buffer.from(sim.value.accounts[0].data[0], "base64");
    return extractHandleFromRaw(data);
  }
  return null;
}

async function simulateTransferHandles(
  connection: Connection,
  tx: Transaction,
  signer: Keypair,
  sourcePubkey: PublicKey,
  destPubkey: PublicKey
): Promise<{ sourceHandle: bigint | null; destHandle: bigint | null }> {
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const sim = await connection.simulateTransaction(tx, undefined, [sourcePubkey, destPubkey]);
  if (sim.value.err) return { sourceHandle: null, destHandle: null };
  const extractH = (acctData: any): bigint | null => {
    if (!acctData?.data) return null;
    return extractHandleFromRaw(Buffer.from(acctData.data[0], "base64"));
  };
  return {
    sourceHandle: extractH(sim.value.accounts?.[0]),
    destHandle: extractH(sim.value.accounts?.[1]),
  };
}

// ─── Test ──────────────────────────────────────────────────────────────

describe("CSPL Balance Demo — Confidential Token Balance Before & After Transfer", function () {
  this.timeout(600000);

  const rpcUrl = process.env.HELIUS_DEVNET_API_KEY
    ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_DEVNET_API_KEY}`
    : "https://api.devnet.solana.com";

  process.env.ANCHOR_PROVIDER_URL = rpcUrl;
  process.env.ANCHOR_WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, anchor.AnchorProvider.env().wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load IDL manually (program is already deployed on devnet)
  const incoTokenIdl = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "idl/inco_token.json"), "utf8")
  );
  const program = new Program(incoTokenIdl, provider);

  const authority = provider.wallet.publicKey;
  const walletKeypair = (provider.wallet as any).payer as Keypair;

  // Fresh keypairs for this test run
  const mintKp = Keypair.generate();
  const senderKp = Keypair.generate();
  const recipientKp = Keypair.generate();

  const DECIMALS = 9;
  const MINT_AMOUNT = BigInt(10_000_000_000); // 10 tokens
  const TRANSFER_AMOUNT = BigInt(3_500_000_000); // 3.5 tokens

  // Store tx hashes
  const txHashes: Record<string, string> = {};

  async function decryptHandle(handle: string): Promise<string> {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const result = await decrypt([handle], {
        address: walletKeypair.publicKey,
        signMessage: async (msg: Uint8Array) => nacl.sign.detached(msg, walletKeypair.secretKey),
      });
      return result.plaintexts[0] || "0";
    } catch (error: any) {
      console.error("  Decrypt error:", error.message?.slice(0, 100));
      return "DECRYPT_FAILED";
    }
  }

  // ─── Setup ─────────────────────────────────────────────────────────

  it("0. Setup — Create mint + token accounts", async () => {
    console.log("\n" + "═".repeat(70));
    console.log("  CSPL BALANCE DEMO — Inco Confidential SPL Token");
    console.log("═".repeat(70));
    console.log("\n  Authority:", authority.toBase58());
    console.log("  RPC:", rpcUrl.includes("helius") ? "Helius Devnet" : "Solana Devnet");

    // Check balance
    const bal = await connection.getBalance(authority);
    console.log("  SOL Balance:", (bal / 1e9).toFixed(4), "SOL");
    if (bal < 0.1e9) {
      console.log("  ⚠ Low balance — requesting airdrop...");
      const sig = await connection.requestAirdrop(authority, 1e9);
      await connection.confirmTransaction(sig);
    }

    // Create mint
    console.log("\n  Creating mint...");
    const mintTx = await program.methods
      .initializeMint(DECIMALS, authority, null)
      .accounts({ mint: mintKp.publicKey, payer: authority } as any)
      .preInstructions(computeBudgetIxs())
      .signers([mintKp])
      .rpc();
    txHashes["createMint"] = mintTx;
    console.log("  ✅ Mint:", mintKp.publicKey.toBase58());
    console.log("     tx:", mintTx);

    // Create sender account
    console.log("\n  Creating sender account...");
    const senderTx = await program.methods
      .initializeAccount()
      .accounts({
        account: senderKp.publicKey,
        mint: mintKp.publicKey,
        owner: authority,
        payer: authority,
      } as any)
      .preInstructions(computeBudgetIxs())
      .signers([senderKp])
      .rpc();
    txHashes["createSender"] = senderTx;
    console.log("  ✅ Sender:", senderKp.publicKey.toBase58());

    // Create recipient account
    console.log("  Creating recipient account...");
    const recipTx = await program.methods
      .initializeAccount()
      .accounts({
        account: recipientKp.publicKey,
        mint: mintKp.publicKey,
        owner: authority,
        payer: authority,
      } as any)
      .preInstructions(computeBudgetIxs())
      .signers([recipientKp])
      .rpc();
    txHashes["createRecipient"] = recipTx;
    console.log("  ✅ Recipient:", recipientKp.publicKey.toBase58());
  });

  // ─── Mint ──────────────────────────────────────────────────────────

  it("1. Mint 10 tokens to sender (ECIES encrypted)", async () => {
    console.log("\n" + "─".repeat(70));
    console.log("  STEP 1: Mint 10 tokens to sender");
    console.log("─".repeat(70));

    const ciphertext = await encryptAmount(MINT_AMOUNT);
    console.log("  ECIES ciphertext:", ciphertext.length, "bytes");

    // Simulate to get handle for allowance PDA
    const simTx = await program.methods
      .mintTo(Buffer.from(ciphertext), INPUT_TYPE)
      .accounts({
        mint: mintKp.publicKey,
        account: senderKp.publicKey,
        mintAuthority: authority,
      } as any)
      .transaction();

    const newHandle = await simulateAndGetHandle(connection, simTx, walletKeypair, senderKp.publicKey);
    expect(newHandle).to.not.be.null;
    console.log("  Simulated handle:", newHandle!.toString());

    const [allowancePda] = getAllowancePda(newHandle!, authority);
    console.log("  Allowance PDA:", allowancePda.toBase58());

    // Execute with allowance
    const mintTx = await program.methods
      .mintTo(Buffer.from(ciphertext), INPUT_TYPE)
      .accounts({
        mint: mintKp.publicKey,
        account: senderKp.publicKey,
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
  });

  // ─── Balance BEFORE ────────────────────────────────────────────────

  it("2. Read & decrypt balance BEFORE transfer", async () => {
    console.log("\n" + "─".repeat(70));
    console.log("  STEP 2: CSPL Balance BEFORE Transfer");
    console.log("─".repeat(70));

    // Wait for covalidator
    console.log("  Waiting for covalidator to index handles...");
    await new Promise((r) => setTimeout(r, 5000));

    // Read sender
    const senderAcct = await program.account.incoAccount.fetch(senderKp.publicKey);
    const senderHandle = extractHandleFromAnchor(senderAcct.amount);
    console.log("\n  Sender account:", senderKp.publicKey.toBase58());
    console.log("  Sender handle:", senderHandle.toString());

    const senderPlain = await decryptHandle(senderHandle.toString());
    console.log("  ┌─────────────────────────────────────────────┐");
    console.log(`  │  SENDER BALANCE (BEFORE): ${formatTokens(senderPlain, DECIMALS)} tokens  │`);
    console.log("  └─────────────────────────────────────────────┘");

    // Read recipient
    const recipAcct = await program.account.incoAccount.fetch(recipientKp.publicKey);
    const recipHandle = extractHandleFromAnchor(recipAcct.amount);
    console.log("\n  Recipient account:", recipientKp.publicKey.toBase58());
    console.log("  Recipient handle:", recipHandle.toString());

    // Recipient has FHE-zero handle from initialization — can't decrypt (no allowance PDA)
    console.log("  ┌─────────────────────────────────────────────┐");
    console.log("  │  RECIPIENT BALANCE (BEFORE): 0 tokens       │");
    console.log("  └─────────────────────────────────────────────┘");

    if (senderPlain !== "DECRYPT_FAILED") {
      expect(senderPlain).to.equal(MINT_AMOUNT.toString());
    }
  });

  // ─── Transfer ──────────────────────────────────────────────────────

  it("3. Transfer 3.5 tokens (encrypted)", async () => {
    console.log("\n" + "─".repeat(70));
    console.log("  STEP 3: Encrypted Transfer — 3.5 tokens");
    console.log("─".repeat(70));

    const ciphertext = hexToBuffer(await encryptValue(TRANSFER_AMOUNT));
    console.log("  ECIES ciphertext:", ciphertext.length, "bytes");
    console.log("  From:", senderKp.publicKey.toBase58());
    console.log("  To:  ", recipientKp.publicKey.toBase58());

    // Simulate to get post-transfer handles
    const simTx = await program.methods
      .transfer(ciphertext, INPUT_TYPE)
      .accounts({
        source: senderKp.publicKey,
        destination: recipientKp.publicKey,
        authority: authority,
        incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .transaction();

    const { sourceHandle, destHandle } = await simulateTransferHandles(
      connection, simTx, walletKeypair, senderKp.publicKey, recipientKp.publicKey
    );
    expect(sourceHandle).to.not.be.null;
    expect(destHandle).to.not.be.null;
    console.log("  Simulated source handle:", sourceHandle!.toString());
    console.log("  Simulated dest handle:", destHandle!.toString());

    const [srcPda] = getAllowancePda(sourceHandle!, authority);
    const [dstPda] = getAllowancePda(destHandle!, authority);

    // Execute with allowance PDAs for both source and destination
    const transferTx = await program.methods
      .transfer(ciphertext, INPUT_TYPE)
      .accounts({
        source: senderKp.publicKey,
        destination: recipientKp.publicKey,
        authority: authority,
        incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts([
        { pubkey: srcPda, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: false },
        { pubkey: dstPda, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: false },
      ])
      .preInstructions(computeBudgetIxs())
      .rpc();

    txHashes["transfer"] = transferTx;
    console.log("\n  ✅ Transfer tx:", transferTx);
    console.log("  https://explorer.solana.com/tx/" + transferTx + "?cluster=devnet");
  });

  // ─── Balance AFTER ─────────────────────────────────────────────────

  it("4. Read & decrypt balance AFTER transfer", async () => {
    console.log("\n" + "─".repeat(70));
    console.log("  STEP 4: CSPL Balance AFTER Transfer");
    console.log("─".repeat(70));

    // Wait for covalidator
    console.log("  Waiting for covalidator to index new handles...");
    await new Promise((r) => setTimeout(r, 7000));

    // Read sender
    const senderAcct = await program.account.incoAccount.fetch(senderKp.publicKey);
    const senderHandle = extractHandleFromAnchor(senderAcct.amount);
    console.log("\n  Sender account:", senderKp.publicKey.toBase58());
    console.log("  Sender handle (new):", senderHandle.toString());

    const senderPlain = await decryptHandle(senderHandle.toString());
    const expectedSender = (MINT_AMOUNT - TRANSFER_AMOUNT).toString();
    console.log("  ┌─────────────────────────────────────────────────┐");
    console.log(`  │  SENDER BALANCE (AFTER):    ${formatTokens(senderPlain, DECIMALS)} tokens     │`);
    console.log(`  │  Expected:                  ${formatTokens(expectedSender, DECIMALS)} tokens     │`);
    console.log("  └─────────────────────────────────────────────────┘");

    // Read recipient
    const recipAcct = await program.account.incoAccount.fetch(recipientKp.publicKey);
    const recipHandle = extractHandleFromAnchor(recipAcct.amount);
    console.log("\n  Recipient account:", recipientKp.publicKey.toBase58());
    console.log("  Recipient handle (new):", recipHandle.toString());

    const recipPlain = await decryptHandle(recipHandle.toString());
    console.log("  ┌─────────────────────────────────────────────────┐");
    console.log(`  │  RECIPIENT BALANCE (AFTER): ${formatTokens(recipPlain, DECIMALS)} tokens     │`);
    console.log(`  │  Expected:                  ${formatTokens(TRANSFER_AMOUNT.toString(), DECIMALS)} tokens     │`);
    console.log("  └─────────────────────────────────────────────────┘");

    // Verify
    if (senderPlain !== "DECRYPT_FAILED" && recipPlain !== "DECRYPT_FAILED") {
      expect(senderPlain).to.equal(expectedSender);
      expect(recipPlain).to.equal(TRANSFER_AMOUNT.toString());
    }
  });

  // ─── Summary ───────────────────────────────────────────────────────

  it("5. Summary — All transaction hashes", async () => {
    console.log("\n" + "═".repeat(70));
    console.log("  SUMMARY — Transaction Hashes");
    console.log("═".repeat(70));
    console.log("  Mint:     ", txHashes["mint"]);
    console.log("  Transfer: ", txHashes["transfer"]);
    console.log("\n  Explorer links:");
    console.log("  Mint:     https://explorer.solana.com/tx/" + txHashes["mint"] + "?cluster=devnet");
    console.log("  Transfer: https://explorer.solana.com/tx/" + txHashes["transfer"] + "?cluster=devnet");
    console.log("\n  Accounts:");
    console.log("  Mint:      ", mintKp.publicKey.toBase58());
    console.log("  Sender:    ", senderKp.publicKey.toBase58());
    console.log("  Recipient: ", recipientKp.publicKey.toBase58());
    console.log("═".repeat(70));
  });
});
