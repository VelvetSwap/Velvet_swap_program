import { BN } from '@coral-xyz/anchor';
import { PublicKey, type AccountMeta } from '@solana/web3.js';
import {
    bn,
    createRpc,
    type HashWithTree,
    type ParsedTokenAccount,
    type Rpc,
    type TreeInfo,
    type ValidityProofWithContext,
} from '@lightprotocol/stateless.js';
import {
    packCompressedTokenAccounts,
    selectMinCompressedTokenAccountsForTransfer,
    type TokenTransferOutputData,
} from '@lightprotocol/compressed-token';

export type CompressedTransferInputs = {
    rpc: Rpc;
    owner: PublicKey;
    mint: PublicKey;
    recipient: PublicKey;
    amount: BN | number;
    maxInputs?: number;
    outputStateTreeInfo?: TreeInfo;
    extraRemainingAccounts?: PublicKey[];
};

export type CompressedTransferBundle = {
    inputAccounts: ParsedTokenAccount[];
    inputTokenDataWithContext: unknown[];
    outputCompressedAccounts: TokenTransferOutputData[];
    outputStateMerkleTreeAccountIndices: number[];
    remainingAccountMetas: AccountMeta[];
    compressedProof: ValidityProofWithContext['compressedProof'];
    rootIndices: ValidityProofWithContext['rootIndices'];
    totalInputAmount: BN;
    changeAmount: BN;
};

export const createDevnetLightRpc = () => {
    const apiKey = process.env.HELIUS_DEVNET_API_KEY;
    const rpcUrl =
        process.env.HELIUS_DEVNET_RPC_URL ??
        (apiKey ? `https://devnet.helius-rpc.com/?api-key=${apiKey}` : undefined);

    if (!rpcUrl) {
        throw new Error(
            'Missing Helius devnet RPC URL. Set HELIUS_DEVNET_RPC_URL or HELIUS_DEVNET_API_KEY.',
        );
    }

    return createRpc(rpcUrl);
};

const ensureInputs = (inputAccounts: ParsedTokenAccount[]) => {
    if (inputAccounts.length === 0) {
        throw new Error('No compressed token accounts available for transfer.');
    }

    const owner = inputAccounts[0].parsed.owner;
    if (!inputAccounts.every(account => account.parsed.owner.equals(owner))) {
        throw new Error('Input compressed token accounts must share one owner.');
    }

    return owner;
};

const buildTransferOutputs = (
    inputAccounts: ParsedTokenAccount[],
    recipient: PublicKey,
    amount: BN,
) => {
    const owner = ensureInputs(inputAccounts);
    const totalInputAmount = inputAccounts.reduce(
        (sum, account) => sum.add(account.parsed.amount),
        bn(0),
    );

    if (totalInputAmount.lt(amount)) {
        throw new Error(
            `Insufficient compressed token balance. Required ${amount.toString()}, available ${totalInputAmount.toString()}.`,
        );
    }

    const changeAmount = totalInputAmount.sub(amount);
    const outputs: TokenTransferOutputData[] = [
        {
            owner: recipient,
            amount,
            lamports: null,
            tlv: null,
        },
    ];

    if (changeAmount.gt(bn(0))) {
        outputs.push({
            owner,
            amount: changeAmount,
            lamports: null,
            tlv: null,
        });
    }

    return { outputs, totalInputAmount, changeAmount };
};

const buildProofInputs = (inputAccounts: ParsedTokenAccount[]): HashWithTree[] =>
    inputAccounts.map(account => ({
        hash: account.compressedAccount.hash,
        tree: account.compressedAccount.treeInfo.tree,
        queue: account.compressedAccount.treeInfo.queue,
    }));

export const buildCompressedTransferBundle = async (
    params: CompressedTransferInputs,
): Promise<CompressedTransferBundle> => {
    const {
        rpc,
        owner,
        mint,
        recipient,
        amount,
        maxInputs,
        outputStateTreeInfo,
        extraRemainingAccounts,
    } = params;

    const transferAmount = bn(amount);
    const compressedTokenAccounts = await rpc.getCompressedTokenAccountsByOwner(
        owner,
        { mint },
    );

    const [inputAccounts] = selectMinCompressedTokenAccountsForTransfer(
        compressedTokenAccounts.items,
        transferAmount,
        maxInputs,
    );

    const proof = await rpc.getValidityProofV0(buildProofInputs(inputAccounts));
    const { outputs, totalInputAmount, changeAmount } = buildTransferOutputs(
        inputAccounts,
        recipient,
        transferAmount,
    );

    const {
        inputTokenDataWithContext,
        packedOutputTokenData,
        remainingAccountMetas,
    } = packCompressedTokenAccounts({
        inputCompressedTokenAccounts: inputAccounts,
        outputStateTreeInfo,
        remainingAccounts: extraRemainingAccounts,
        rootIndices: proof.rootIndices,
        tokenTransferOutputs: outputs,
    });

    const outputCompressedAccounts = packedOutputTokenData.map(output => ({
        owner: output.owner,
        amount: output.amount,
        lamports: output.lamports,
        tlv: output.tlv,
    }));

    const outputStateMerkleTreeAccountIndices = packedOutputTokenData.map(
        output => output.merkleTreeIndex,
    );

    return {
        inputAccounts,
        inputTokenDataWithContext,
        outputCompressedAccounts,
        outputStateMerkleTreeAccountIndices,
        remainingAccountMetas,
        compressedProof: proof.compressedProof,
        rootIndices: proof.rootIndices,
        totalInputAmount,
        changeAmount,
    };
};
