import * as light from "@lightprotocol/zk.js";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  airdropSol,
  confirmConfig,
  TestRelayer,
  User,
} from "@lightprotocol/zk.js";

const apiKey = process.env.HELIUS_DEVNET_API_KEY;
const rpcUrl =
  process.env.HELIUS_DEVNET_RPC_URL ??
  (apiKey ? `https://devnet.helius-rpc.com/?api-key=${apiKey}` : undefined);

if (!rpcUrl) {
  throw new Error(
    "Missing Helius devnet RPC URL. Set HELIUS_DEVNET_RPC_URL or HELIUS_DEVNET_API_KEY."
  );
}

process.env.ANCHOR_WALLET =
  process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
process.env.ANCHOR_PROVIDER_URL = rpcUrl;

const provider = new anchor.AnchorProvider(
  new anchor.web3.Connection(rpcUrl, confirmConfig),
  anchor.Wallet.local(),
  confirmConfig
);

const log = console.log;

const main = async () => {
  log("initializing Solana wallet...");
  const solanaWallet = anchor.web3.Keypair.generate();

  log("requesting airdrop...");
  await airdropSol({
    connection: provider.connection,
    lamports: 2e9,
    recipientPublicKey: solanaWallet.publicKey,
  });

  log("setting up test relayer...");
  const testRelayer = new TestRelayer({
    relayerPubkey: solanaWallet.publicKey,
    relayerRecipientSol: solanaWallet.publicKey,
    relayerFee: new BN(100_000),
    payer: solanaWallet,
  });

  log("initializing light provider...");
  const lightProvider = await light.Provider.init({
    wallet: solanaWallet,
    relayer: testRelayer,
    confirmConfig,
  });

  log("initializing user...");
  const user = await light.User.init({ provider: lightProvider });

  log("performing shield operation...");
  await user.shield({
    publicAmountSol: "1",
    token: "SOL",
  });

  log("getting user balance...");
  log(await user.getBalance());

  log("generating test recipient keypair...");
  const testRecipientKeypair = anchor.web3.Keypair.generate();

  log("requesting airdrop for recipient...");
  await airdropSol({
    connection: provider.connection,
    lamports: 2e9,
    recipientPublicKey: testRecipientKeypair.publicKey,
  });

  log("initializing light provider recipient...");
  const lightProviderRecipient = await light.Provider.init({
    wallet: testRecipientKeypair,
    relayer: testRelayer,
    confirmConfig,
  });

  log("initializing light user recipient...");
  const testRecipient: User = await light.User.init({
    provider: lightProviderRecipient,
  });

  log("executing transfer...");
  const response = await user.transfer({
    amountSol: "0.25",
    token: "SOL",
    recipient: testRecipient.account.getPublicKey(),
  });

  log("getting tx hash...");
  log(response.txHash);
  log("getting UTXO inbox...");
  log(await testRecipient.getUtxoInbox());
};

log("running program...");
main()
  .then(() => {
    log("run complete.");
  })
  .catch((error) => {
    console.error(error);
  })
  .finally(() => {
    process.exit(0);
  });
