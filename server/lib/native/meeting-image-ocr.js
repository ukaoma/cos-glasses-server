// Apple Vision parity with COS Control's WorkCardFiles.recognizeText.
// Runs under macOS's built-in JXA; no developer tools or API key required.
ObjC.import('Foundation');
ObjC.import('Vision');
function run(args) {
  if (args.length !== 1) throw new Error('invalid_input');
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = 0; // VNRequestTextRecognitionLevelAccurate
  request.usesLanguageCorrection = true;
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(args[0]), $({}));
  const error = Ref();
  if (!handler.performRequestsError($([request]), error)) throw new Error('recognition_failed');
  const results = request.results;
  const lines = [];
  for (let i = 0; i < results.count; i++) {
    const candidates = results.objectAtIndex(i).topCandidates(1);
    if (candidates.count) {
      const box = results.objectAtIndex(i).boundingBox;
      lines.push({text: ObjC.unwrap(candidates.objectAtIndex(0).string), confidence: Number(candidates.objectAtIndex(0).confidence), x: box.origin.x, y: box.origin.y + box.size.height / 2, height: box.size.height});
    }
  }
  return JSON.stringify({lines});
}
