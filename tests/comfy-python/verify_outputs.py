import json
from pathlib import Path
import sys
import av
from PIL import Image

root = Path(sys.argv[1])
proof = root / '.runtime/comfy-runs-proof'
evidence = json.loads((proof / 'evidence.json').read_text(encoding='utf-8'))
with Image.open(root / evidence['imageResult']['assets'][0]['relativePath']) as image:
    assert image.size == (16, 24)
    assert 'FAKE_Task6_PRIVATE_VENDOR_KEY_674033' not in json.dumps(image.info)
with av.open(str(root / evidence['videoResult']['assets'][0]['relativePath'])) as container:
    metadata = json.dumps(container.metadata)
    assert 'FAKE_Task6_PRIVATE_VENDOR_KEY_674033' not in metadata
    assert 'MixcatAPIVideo' in metadata
    codec = container.streams.video[0].codec_context.name
    frames = list(container.decode(video=0))
    assert len(frames) == 2
    assert all(frame.width == 32 and frame.height == 32 for frame in frames)
    report = {'passed': True, 'nativeFinalImage': [16, 24], 'videoFrames': len(frames),
              'videoDimensions': [32, 32], 'videoCodec': codec,
              'nativeVideoPromptMetadata': True, 'fakeKeyLeaks': 0}
(proof / 'native-media-validation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
