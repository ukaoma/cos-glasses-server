// GENERATED from the 2026-10-10 bake-off model manifest (private corpus MODEL_MANIFEST.json).
// Every file of each pinned Hugging Face revision, with its size and SHA-256. The installer
// refuses any byte that does not match. Do not edit by hand: a changed hash is a new model.

export interface PinnedFile { path: string; size: number; sha256: string }
export interface PinnedModel { id: string; repo: string; revision: string; modelVersion: string; files: PinnedFile[] }

/** fluidaudiocli 0.17.4, the same binary the Nemotron diarizer pins (nemotron-live.ts KNOWN_CLI_SHA256). */
export const PARAKEET_CLI = { version: '0.17.4', sha256: '4714154623b59c40404563828cb0fbeb4da6878e90f582ad776c1c2cd061d35a', size: 22039856 } as const

export const PARAKEET_ULTRA: PinnedModel = {
  id: 'parakeet-ultra', repo: 'FluidInference/parakeet-ultra-coreml', revision: '95eaa59a39d4394f047a4dc5cce480388a60d1b6', modelVersion: 'ultra',
  files: [
    { path: 'Decoder.mlmodelc/analytics/coremldata.bin', size: 243, sha256: 'fe92b6cfaa012abd5248c0bc877832f19807015abffc60d87b8ccc8ccb48b3b5' },
    { path: 'Decoder.mlmodelc/coremldata.bin', size: 560, sha256: '3b06e66768f0df7e21795f50e2b29300e33eeb1a2579dc42c695279c2d308497' },
    { path: 'Decoder.mlmodelc/model.mil', size: 13110, sha256: '956f600207f88396017ca5c96cfa3acd5bfee60835a5b44b762e033a8fb28955' },
    { path: 'Decoder.mlmodelc/weights/weight.bin', size: 23604992, sha256: '02a0d219f281b9665bc10c8768649403b2eebbbf4b44c627041d948e0de11bb4' },
    { path: 'Encoder.mlmodelc/analytics/coremldata.bin', size: 243, sha256: 'd87101d824d6723cf95304da33755c3c60e762663b9ef2b0c4bd0aa166a09a0d' },
    { path: 'Encoder.mlmodelc/coremldata.bin', size: 514, sha256: '397a84a4062f563cbc5f56077c674f09a61d85be5090f61d2f1932afb92ac0fe' },
    { path: 'Encoder.mlmodelc/model.mil', size: 1002653, sha256: 'f5d601568a4171d99a314c0fe3f6bc67715da2623732a3fb566e050ea83e5848' },
    { path: 'Encoder.mlmodelc/weights/weight.bin', size: 594211328, sha256: '315ba01f33cadbf601d43ac7f5c86208b7aa75fdaa34705c9869d5abe3521c9b' },
    { path: 'JointDecisionv3.mlmodelc/analytics/coremldata.bin', size: 243, sha256: '68d38ca646aebafa7a9329e2efda50f5767c49e89fdb5f77f212072bb66f97c4' },
    { path: 'JointDecisionv3.mlmodelc/coremldata.bin', size: 592, sha256: '5e3af5a4ce686f6c237cadbd9284e10d333bc0e1546633cd0e430e6194044bc4' },
    { path: 'JointDecisionv3.mlmodelc/model.mil', size: 11777, sha256: '791b3c3cf3eb2079c84623fc880f6bba008d1366e5f8b03e9a8ed8bd4d7194a0' },
    { path: 'JointDecisionv3.mlmodelc/weights/weight.bin', size: 12642764, sha256: '3f310b85b82341c53ec383025ab094a4e462ee1c592e1ad7c6bfe39cff66ca25' },
    { path: 'Preprocessor.mlmodelc/analytics/coremldata.bin', size: 243, sha256: 'c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d' },
    { path: 'Preprocessor.mlmodelc/coremldata.bin', size: 486, sha256: 'dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d' },
    { path: 'Preprocessor.mlmodelc/metadata.json', size: 2841, sha256: '2a98699e22d279dd37fa1d238aeb1c6db1df0d6fad687775324157689d8f3acf' },
    { path: 'Preprocessor.mlmodelc/model.mil', size: 28181, sha256: '4b8518a956450fec57f06c2a21bdffc26973f7f1fa6842fb38fe917f896b6b93' },
    { path: 'Preprocessor.mlmodelc/weights/weight.bin', size: 491072, sha256: '129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea' },
    { path: 'README.md', size: 2235, sha256: '9e9e26b6da628a0dc34b9c55f2029e486fc02304ccd7f83825333572ae11c158' },
    { path: 'config.json', size: 414, sha256: '965c69bf500c7be18958df6438dc1ba897721690ae412937ca7c91e28cec1870' },
    { path: 'parakeet_v3_vocab.json', size: 151122, sha256: '7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735' },
    { path: 'parakeet_vocab.json', size: 151122, sha256: '7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735' },
  ],
}

export const PARAKEET_V2: PinnedModel = {
  id: 'parakeet-v2', repo: 'FluidInference/parakeet-tdt-0.6b-v2-coreml', revision: 'ee09c569f73759e6d44c9bd16766f477b2b36d39', modelVersion: 'v2',
  files: [
    { path: 'Decoder.mlmodelc/analytics/coremldata.bin', size: 243, sha256: '46de1a6fe2e49d19a2125bc91acf020df7f2aea84ba821532aade8427a440b05' },
    { path: 'Decoder.mlmodelc/coremldata.bin', size: 554, sha256: 'd200ca07694a347f6d02a3886a062ae839831e094e443222f2e48a14945966a8' },
    { path: 'Decoder.mlmodelc/metadata.json', size: 3427, sha256: '90a279b822496316458febc0ce761ab05954fadd9d66aa97bea077a35fc8f2b2' },
    { path: 'Decoder.mlmodelc/model.mil', size: 13106, sha256: '7b95a5a6b672c652000348a67b6d4d92bb8e176b978c6666fe73c28a4d7ec579' },
    { path: 'Decoder.mlmodelc/weights/weight.bin', size: 14429952, sha256: '27d26890221d82322c1092fd99d7b40578e435d5cf4b83c887c42603caf97aba' },
    { path: 'Encoder.mlmodelc/analytics/coremldata.bin', size: 243, sha256: '42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105' },
    { path: 'Encoder.mlmodelc/coremldata.bin', size: 485, sha256: '4def7aa848599ad0e17a8b9a982edcdbf33cf92e1f4b798de32e2ca0bc74b030' },
    { path: 'Encoder.mlmodelc/metadata.json', size: 2926, sha256: '58222fbc48c13c49d9715567803cd50cb9c23e4360462e0f8ffcea59a2c73c63' },
    { path: 'Encoder.mlmodelc/model.mil', size: 959769, sha256: 'ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808' },
    { path: 'Encoder.mlmodelc/weights/weight.bin', size: 445187200, sha256: '4adc7ad44f9d05e1bffeb2b06d3bb02861a5c7602dff63a6b494aed3bf8a6c3e' },
    { path: 'JointDecision.mlmodelc/analytics/coremldata.bin', size: 243, sha256: 'f1183ba213bb94a918c8d2cad19ab045320618f97f6ca662245b3936d7b090f7' },
    { path: 'JointDecision.mlmodelc/coremldata.bin', size: 534, sha256: 'e2c6752f1c8cf2d3f6f26ec93195c9bfa759ad59edf9f806696a138154f96f11' },
    { path: 'JointDecision.mlmodelc/metadata.json', size: 2936, sha256: 'ba8d309417b9acd4a175fdb15687de6a941db2f5b06666a60e7cf3cc8e2d3c3c' },
    { path: 'JointDecision.mlmodelc/model.mil', size: 9722, sha256: '93bf82042235127cb81ab537dcae47a1c2e7e242ce4ffdaf772981b45eedc4f0' },
    { path: 'JointDecision.mlmodelc/weights/weight.bin', size: 3453388, sha256: 'ca22a65903a05e64137677da608077578a8606090a598abf4875fa6199aaa19d' },
    { path: 'Preprocessor.mlmodelc/analytics/coremldata.bin', size: 243, sha256: '03ab3c1327a054c54c07a40325db967ec574f2c91dcc8192bfa44aa561bcf2d8' },
    { path: 'Preprocessor.mlmodelc/coremldata.bin', size: 494, sha256: 'd88ea1fc349459c9e100d6a96688c5b29a1f0d865f544be103001724b986b6d6' },
    { path: 'Preprocessor.mlmodelc/metadata.json', size: 2974, sha256: 'fb16c581ff5e1b962e7cb2181ed892cd32f9f84c12b6e80ff3e089f28e35bcbb' },
    { path: 'Preprocessor.mlmodelc/model.mil', size: 27166, sha256: '3e06d16fd061294c8a75be68c43a3b1ed1f593d4a9c35249e9cdbccadc59721e' },
    { path: 'Preprocessor.mlmodelc/weights/weight.bin', size: 298880, sha256: 'a5f7df6c7f47147ae9486fe18cc7792f9a44d093ec3c6a11e91ef2dc363c48dc' },
    { path: 'README.md', size: 1665, sha256: '491eac9a160dc7b0f7ce1210dea4fff6df0222124e93ea83ae2cd72827b4ce02' },
    { path: 'config.json', size: 3, sha256: 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356' },
    { path: 'parakeet_vocab.json', size: 18762, sha256: '57019fe3c745772ca83a1b048a4bb951cd51329504ea33d4d83316b96e279a97' },
  ],
}

export const PARAKEET_MODELS: readonly PinnedModel[] = [PARAKEET_ULTRA, PARAKEET_V2]
