/**
 * Create User IncoAccounts for a wallet
 * 
 * Usage: npx ts-node scripts/create-user-account.ts [wallet_pubkey]
 * If no wallet_pubkey provided, uses the default wallet from ~/.config/solana/id.json
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { encryptValue } from "@inco/solana-sdk";
import { hexToBuffer } from "@inco/solana-sdk";
import * as fs from "fs";
import * as path from "path";

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

interface UserConfig {
  wallet: string;
  userTokenA: string;
  userTokenB: string;
}

const INPUT_TYPE = 0;

async function main() {
  // Load devnet config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ Config not found. Run setup-devnet-accounts.ts first.");
    process.exit(1);
  }
  const config: DevnetConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

  console.log("=".repeat(60));
  console.log("Create User IncoAccounts");
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

  // Get user wallet (from arg or default)
  const userWallet = process.argv[2] 
    ? new PublicKey(process.argv[2]) 
    : wallet.publicKey;
  
  console.log("\nUser Wallet:", userWallet.toBase58());
  console.log("Inco Mint A:", config.incoMintA);
  console.log("Inco Mint B:", config.incoMintB);

  // Load inco-token program
  const incoTokenIdl = require("../deps/lightning-rod-solana/target/idl/inco_token.json");
  const incoTokenProgram = new Program(incoTokenIdl, provider);

  // Generate keypairs for user accounts
  const userTokenA = Keypair.generate();
  const userTokenB = Keypair.generate();

  console.log("\nUser Token Accounts:");
  console.log("  Token A:", userTokenA.publicKey.toBase58());
  console.log("  Token B:", userTokenB.publicKey.toBase58());

  const computeBudgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  ];

  const encryptAmount = async (amount: bigint) => hexToBuffer(await encryptValue(amount));

  // 1. Create User Token A Account
  console.log("\n1. Creating User Token A Account...");
  try {
    const tx = await incoTokenProgram.methods
      .initializeAccount()
      .accounts({
        account: userTokenA.publicKey,
        mint: new PublicKey(config.incoMintA),
        owner: userWallet,
        payer: wallet.publicKey,
      })
      .preInstructions(computeBudgetIxs)
      .signers([userTokenA])
      .rpc();
    console.log("   ✅ Created:", tx);
  } catch (e: any) {
    console.error("   ❌ Failed:", e.message);
    throw e;
  }

  // 2. Create User Token B Account
  console.log("\n2. Creating User Token B Account...");
  try {
    const tx = await incoTokenProgram.methods
      .initializeAccount()
      .accounts({
        account: userTokenB.publicKey,
        mint: new PublicKey(config.incoMintB),
        owner: userWallet,
        payer: wallet.publicKey,
      })
      .preInstructions(computeBudgetIxs)
      .signers([userTokenB])
      .rpc();
    console.log("   ✅ Created:", tx);
  } catch (e: any) {
    console.error("   ❌ Failed:", e.message);
    throw e;
  }

  // 3. Mint some tokens to user for testing (10 wSOL)
  console.log("\n3. Minting 10 wSOL to User Token A...");
  try {
    const amount = BigInt(10_000_000_000); // 10 tokens (9 decimals)
    const encryptedAmount = await encryptAmount(amount);
    const tx = await incoTokenProgram.methods
      .mintTo(Buffer.from(encryptedAmount), INPUT_TYPE)
      .accounts({
        mint: new PublicKey(config.incoMintA),
        account: userTokenA.publicKey,
        mintAuthority: wallet.publicKey,
      })
      .preInstructions(computeBudgetIxs)
      .rpc();
    console.log("   ✅ Minted:", tx);
  } catch (e: any) {
    console.error("   ❌ Failed:", e.message);
    throw e;
  }

  // Save user config
  const userConfig: UserConfig = {
    wallet: userWallet.toBase58(),
    userTokenA: userTokenA.publicKey.toBase58(),
    userTokenB: userTokenB.publicKey.toBase58(),
  };

  const userConfigPath = path.join(__dirname, `../user-${userWallet.toBase58().slice(0, 8)}.json`);
  fs.writeFileSync(userConfigPath, JSON.stringify(userConfig, null, 2));

  console.log("\n" + "=".repeat(60));
  console.log("User Accounts Created!");
  console.log("=".repeat(60));
  console.log("\nUser config saved to:", userConfigPath);
  console.log("\nTo use in frontend, pass these to swapExactIn:");
  console.log(`  userTokenA: "${userTokenA.publicKey.toBase58()}"`);
  console.log(`  userTokenB: "${userTokenB.publicKey.toBase58()}"`);
  console.log(`  poolVaultA: "${config.poolVaultA}"`);
  console.log(`  poolVaultB: "${config.poolVaultB}"`);
}

main().catch(console.error);
