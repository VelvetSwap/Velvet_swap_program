import { BN } from '@coral-xyz/anchor';
import { PublicKey, type AccountMeta } from '@solana/web3.js';
import { type Rpc, type TreeInfo } from '@lightprotocol/stateless.js';

import {
    buildCompressedTransferBundle,
    type CompressedTransferBundle,
} from './light-psp-transfer';

export type LightPspSwapTransferConfig = {
    rpc: Rpc;
    user: PublicKey;
    poolAuthority: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    amountIn: BN | number;
    amountOut: BN | number;
    maxInputAccounts?: number;
    maxOutputAccounts?: number;
    inputOutputStateTreeInfo?: TreeInfo;
    outputOutputStateTreeInfo?: TreeInfo;
    baseRemainingAccounts?: PublicKey[];
};

export type LightPspSwapTransferBundles = {
    input: CompressedTransferBundle;
    output: CompressedTransferBundle;
    remainingAccountMetas: AccountMeta[];
};

const toPubkeys = (metas: AccountMeta[]) => metas.map(meta => meta.pubkey);

export const buildSwapTransferBundles = async (
    params: LightPspSwapTransferConfig,
): Promise<LightPspSwapTransferBundles> => {
    const {
        rpc,
        user,
        poolAuthority,
        inputMint,
        outputMint,
        amountIn,
        amountOut,
        maxInputAccounts,
        maxOutputAccounts,
        inputOutputStateTreeInfo,
        outputOutputStateTreeInfo,
        baseRemainingAccounts,
    } = params;

    const input = await buildCompressedTransferBundle({
        rpc,
        owner: user,
        mint: inputMint,
        recipient: poolAuthority,
        amount: amountIn,
        maxInputs: maxInputAccounts,
        outputStateTreeInfo: inputOutputStateTreeInfo,
        extraRemainingAccounts: baseRemainingAccounts,
    });

    const output = await buildCompressedTransferBundle({
        rpc,
        owner: poolAuthority,
        mint: outputMint,
        recipient: user,
        amount: amountOut,
        maxInputs: maxOutputAccounts,
        outputStateTreeInfo: outputOutputStateTreeInfo,
        extraRemainingAccounts: toPubkeys(input.remainingAccountMetas),
    });

    return {
        input,
        output,
        remainingAccountMetas: output.remainingAccountMetas,
    };
};
