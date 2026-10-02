import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAttributes,
  parseIV,
  ivFromSequence,
  parsePlaylist,
  inspectEncryption,
  codecsRemuxable,
  detectContainer,
  summarizePlaylist,
  hasVideo,
  drmSystemName,
  externalAudioFor,
  sortVariants,
  variantLabel,
} from '../extension/lib/hls.js';

const BASE = 'https://cdn.example.com/video/master.m3u8';

test('parseAttributes handles quoted values containing commas', () => {
  const a = parseAttributes('BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=640x360,NAME="HD, 1080"');
  assert.equal(a.BANDWIDTH, '800000');
  assert.equal(a.CODECS, 'avc1.4d401f,mp4a.40.2');
  assert.equal(a.RESOLUTION, '640x360');
  assert.equal(a.NAME, 'HD, 1080');
});

test('parseIV left-pads to 16 bytes and rejects garbage', () => {
  assert.deepEqual([...parseIV('0x01')], [...Array(15).fill(0), 1]);
  assert.equal(parseIV('0x' + 'ab'.repeat(16)).length, 16);
  assert.equal(parseIV('0X' + 'AB'.repeat(16))[0], 0xab);
  assert.equal(parseIV('0xzz'), null);
  assert.equal(parseIV(undefined), null);
  assert.equal(parseIV('0x' + '11'.repeat(17)), null);
});

test('ivFromSequence is the big-endian sequence number in 128 bits (RFC 8216 4.3.2.4)', () => {
  assert.deepEqual([...ivFromSequence(0)], Array(16).fill(0));
  assert.deepEqual([...ivFromSequence(7)], [...Array(15).fill(0), 7]);
  assert.deepEqual([...ivFromSequence(0x01020304)].slice(12), [1, 2, 3, 4]);
  // Above 2^32 the high word goes into bytes 8..11.
  const big = ivFromSequence(2 ** 32 + 5);
  assert.deepEqual([...big].slice(8), [0, 0, 0, 1, 0, 0, 0, 5]);
});

test('master playlist: variants, renditions, relative URLs', () => {
  const p = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="audio/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Deutsch",LANGUAGE="de",URI="audio/de.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en",URI="subs/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1200000,AVERAGE-BANDWIDTH=1000000,RESOLUTION=1280x720,FRAME-RATE=59.94,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"',
      '720/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="aud"',
      'https://other.example.com/360.m3u8?token=1',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframe.m3u8"',
      '',
    ].join('\n'),
    BASE,
  );
  assert.equal(p.type, 'master');
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[0].url, 'https://cdn.example.com/video/720/index.m3u8');
  assert.equal(p.variants[0].height, 720);
  assert.equal(p.variants[0].frameRate, 59.94);
  assert.equal(p.variants[0].avgBandwidth, 1000000);
  assert.equal(p.variants[1].url, 'https://other.example.com/360.m3u8?token=1');
  assert.deepEqual(
    externalAudioFor(p, p.variants[0]).map((m) => m.name),
    ['English', 'Deutsch'],
  );
  assert.deepEqual(
    sortVariants(p.variants).map((v) => v.height),
    [720, 360],
  );
  assert.equal(variantLabel(p.variants[0]), '720p · 60fps · 1.0 Mbps');
  assert.equal(variantLabel(p.variants[1]), '360p · 400 kbps');
});

test('summarizePlaylist(master) lists child playlists so they can be hidden from the popup', () => {
  const p = parsePlaylist(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="a"\nv.m3u8\n',
    BASE,
  );
  const s = summarizePlaylist(p);
  assert.equal(s.maxHeight, 1080);
  assert.deepEqual(s.childUrls.sort(), ['https://cdn.example.com/video/a.m3u8', 'https://cdn.example.com/video/v.m3u8']);
});

test('media playlist: sequence numbers, durations, endlist', () => {
  const p = parsePlaylist(
    '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:4.0,\na.ts\n#EXTINF:3.5,title\nb.ts\n#EXT-X-ENDLIST\n',
    'https://h.example.com/p/index.m3u8',
  );
  assert.equal(p.type, 'media');
  assert.equal(p.endList, true);
  assert.deepEqual(
    p.segments.map((s) => [s.sequence, s.url, s.duration]),
    [
      [100, 'https://h.example.com/p/a.ts', 4],
      [101, 'https://h.example.com/p/b.ts', 3.5],
    ],
  );
  assert.equal(p.duration, 7.5);
});

test('media playlist without ENDLIST is treated as live; sequence defaults to 0', () => {
  const p = parsePlaylist('#EXTM3U\n#EXTINF:2,\na.ts\n', BASE);
  assert.equal(p.endList, false);
  assert.equal(p.segments[0].sequence, 0);
  assert.equal(summarizePlaylist(p).live, true);
});

test('EXT-X-BYTERANGE: explicit offsets, and implicit offset continues the previous range of the same resource', () => {
  const p = parsePlaylist(
    [
      '#EXTM3U',
      '#EXTINF:2,',
      '#EXT-X-BYTERANGE:1000@0',
      'all.ts',
      '#EXTINF:2,',
      '#EXT-X-BYTERANGE:500',
      'all.ts',
      '#EXTINF:2,',
      '#EXT-X-BYTERANGE:200',
      'all.ts',
      '#EXTINF:2,',
      '#EXT-X-BYTERANGE:50',
      'other.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'),
    BASE,
  );
  assert.deepEqual(
    p.segments.map((s) => s.byteRange),
    [
      { offset: 0, length: 1000 },
      { offset: 1000, length: 500 },
      { offset: 1500, length: 200 },
      { offset: 0, length: 50 },
    ],
  );
});

test('EXT-X-KEY applies to following segments until changed or set to NONE', () => {
  const p = parsePlaylist(
    [
      '#EXTM3U',
      '#EXTINF:2,',
      'clear.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="k1.key",IV=0x00000000000000000000000000000009',
      '#EXTINF:2,',
      'e1.ts',
      '#EXTINF:2,',
      'e2.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="k2.key"',
      '#EXTINF:2,',
      'e3.ts',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:2,',
      'clear2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'),
    BASE,
  );
  const [s0, s1, s2, s3, s4] = p.segments;
  assert.equal(s0.key, null);
  assert.equal(s1.key.url, 'https://cdn.example.com/video/k1.key');
  assert.equal(s1.key.iv[15], 9);
  assert.equal(s2.key, s1.key);
  assert.equal(s3.key.url, 'https://cdn.example.com/video/k2.key');
  assert.equal(s3.key.iv, null);
  assert.equal(s4.key, null);
});

test('EXT-X-MAP applies until replaced and remembers the key in effect (RFC 8216 4.3.2.5)', () => {
  const p = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0x00000000000000000000000000000001',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      '#EXTINF:2,',
      's0.m4s',
      '#EXTINF:2,',
      's1.m4s',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-MAP:URI="init2.mp4"',
      '#EXTINF:2,',
      's2.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n'),
    BASE,
  );
  assert.equal(p.segments[0].map.url, 'https://cdn.example.com/video/init.mp4');
  assert.deepEqual(p.segments[0].map.byteRange, { length: 720, offset: 0 });
  assert.equal(p.segments[0].map.key.iv[15], 1);
  assert.equal(p.segments[1].map, p.segments[0].map);
  assert.equal(p.segments[2].map.url, 'https://cdn.example.com/video/init2.mp4');
  assert.equal(p.segments[2].discontinuity, true);
  assert.equal(p.segments[1].discontinuity, false);
  assert.equal(detectContainer(p), 'fmp4');
});

test('inspectEncryption: AES-128 supported, SAMPLE-AES and DRM key formats refused', () => {
  const mk = (keyLine) => parsePlaylist(`#EXTM3U\n${keyLine}\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n`, BASE);
  assert.deepEqual(inspectEncryption(mk('#EXT-X-KEY:METHOD=NONE')), { method: 'NONE', supported: true, drm: false, systems: [], reason: '' });
  assert.equal(inspectEncryption(mk('#EXT-X-KEY:METHOD=AES-128,URI="k"')).supported, true);

  const sample = inspectEncryption(mk('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"'));
  assert.equal(sample.supported, false);
  assert.equal(sample.drm, false);

  const fairplay = inspectEncryption(mk('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"'));
  assert.equal(fairplay.supported, false);
  assert.equal(fairplay.drm, true);
  assert.match(fairplay.reason, /DRM/);

  const widevine = inspectEncryption(mk('#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"'));
  assert.equal(widevine.drm, true);

  assert.equal(inspectEncryption(mk('#EXT-X-KEY:METHOD=AES-128')).supported, false); // no URI
});

test('master playlists with a DRM EXT-X-SESSION-KEY are flagged', () => {
  const p = parsePlaylist(
    '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n',
    BASE,
  );
  assert.equal(summarizePlaylist(p).drm, true);
});

test('detectContainer by extension', () => {
  const c = (name) => detectContainer(parsePlaylist(`#EXTM3U\n#EXTINF:2,\n${name}\n`, BASE));
  assert.equal(c('seg1.ts'), 'ts');
  assert.equal(c('seg1.m4s'), 'fmp4');
  assert.equal(c('seg1.aac'), 'aac');
  assert.equal(c('seg1.mp3'), 'mp3');
  assert.equal(c('seg1?id=2'), 'ts'); // unknown extension: MPEG-TS is the HLS default
});

test('codecsRemuxable accepts only H.264 + AAC', () => {
  assert.equal(codecsRemuxable('avc1.64001f,mp4a.40.2'), true);
  assert.equal(codecsRemuxable('mp4a.40.5'), true);
  assert.equal(codecsRemuxable('hvc1.1.6.L93.B0,mp4a.40.2'), false);
  assert.equal(codecsRemuxable('avc1.64001f,ec-3'), false);
  assert.equal(codecsRemuxable('avc1.64001f,ac-3'), false);
  assert.equal(codecsRemuxable(''), true); // unknown -> decided by probing
});

test('non-HLS text is rejected', () => {
  assert.throws(() => parsePlaylist('<html></html>', BASE), /Not an HLS playlist/);
  assert.throws(() => parsePlaylist('', BASE), /Not an HLS playlist/);
});

test('tolerates BOM and CRLF line endings', () => {
  const p = parsePlaylist('﻿#EXTM3U\r\n#EXTINF:2,\r\na.ts\r\n#EXT-X-ENDLIST\r\n', BASE);
  assert.equal(p.segments.length, 1);
  assert.equal(p.endList, true);
});

test('a plain AES-128 key offered next to FairPlay/Widevine is used: such a stream is not DRM-protected, whatever the tag order', () => {
  const pl = (...keyLines) => parsePlaylist(['#EXTM3U', ...keyLines, '#EXTINF:2,', 'a.ts', '#EXTINF:2,', 'b.ts', '#EXT-X-ENDLIST'].join('\n'), BASE);
  const plain = '#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/key"';
  const fairplay = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://asset",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"';
  const widevine = '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"';
  for (const order of [[plain, fairplay, widevine], [fairplay, widevine, plain], [fairplay, plain]]) {
    const media = pl(...order);
    const enc = inspectEncryption(media);
    assert.equal(enc.supported, true, order.map((l) => l.slice(15, 30)).join(' / '));
    assert.equal(enc.drm, false);
    assert.equal(enc.method, 'AES-128');
    assert.equal(media.segments[0].key.url, 'https://k.example/key');
    assert.ok(media.segments[0].drm.length >= 1, 'the DRM alternatives are still recorded');
  }
});

test('DRM-only streams are refused, name the systems, and data:/skd: key URIs do not break parsing', () => {
  const media = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://asset",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
      '#EXTINF:2,',
      'a.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'),
    BASE,
  );
  const enc = inspectEncryption(media);
  assert.equal(enc.drm, true);
  assert.deepEqual([...enc.systems].sort(), ['FairPlay', 'Widevine']);
  assert.match(enc.reason, /DRM-protected \(.*FairPlay.*\)/);
  assert.equal(summarizePlaylist(media).drm, true);
  assert.deepEqual([...summarizePlaylist(media).drmSystems].sort(), ['FairPlay', 'Widevine']);
  assert.equal(drmSystemName('com.microsoft.playready'), 'PlayReady');
  assert.equal(drmSystemName('urn:uuid:unknown'), 'urn:uuid:unknown');
});

test('a key that is dropped partway (DRM for the rest only) is still DRM', () => {
  const media = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://k/key"',
      '#EXTINF:2,',
      'a.ts',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXTINF:2,',
      'b.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'),
    BASE,
  );
  assert.equal(inspectEncryption(media).drm, true);
});

test('master: a DRM session key alone does not condemn the stream when a plain key exists; all-DRM session keys do', () => {
  const master = (...keys) => parsePlaylist(['#EXTM3U', ...keys, '#EXT-X-STREAM-INF:BANDWIDTH=1', 'v.m3u8'].join('\n'), BASE);
  const fp = '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"';
  const plain = '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://k/key"';
  assert.equal(summarizePlaylist(master(fp, plain)).drm, false);
  assert.equal(summarizePlaylist(master(fp)).drm, true);
  assert.deepEqual(summarizePlaylist(master(fp)).drmSystems, ['FairPlay']);
  assert.equal(summarizePlaylist(master()).drm, false);
});

test('variants without RESOLUTION and CODECS (both optional) are assumed to be video, not audio-only', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nv.m3u8\n', BASE);
  assert.equal(hasVideo(p.variants[0]), true);
  assert.equal(summarizePlaylist(p).audioOnly, false);
  assert.notEqual(variantLabel(p.variants[0]), 'Audio only');
  const audio = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\na.m3u8\n', BASE);
  assert.equal(hasVideo(audio.variants[0]), false);
  assert.equal(summarizePlaylist(audio).audioOnly, true);
});

test('only http(s) URIs are accepted for segments, maps and variants', () => {
  for (const uri of ['file:///C:/secret.ts', 'data:video/mp2t;base64,AAAA', 'blob:https://x/uuid', 'chrome-extension://abc/x.ts', 'ftp://h/x.ts']) {
    assert.throws(() => parsePlaylist(`#EXTM3U\n#EXTINF:2,\n${uri}\n`, BASE), /Unsupported URL scheme/, uri);
  }
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-MAP:URI="file:///x"\n#EXTINF:2,\na.m4s\n', BASE), /Unsupported URL scheme/);
});

test('hostile input is parsed in linear time and capped (a regex-based parser took seconds here)', () => {
  const t0 = performance.now();
  parseAttributes('A'.repeat(500_000));
  parseAttributes(`KEY=${'"'.repeat(200_000)}`);
  parseAttributes(','.repeat(500_000));
  parsePlaylist(`#EXTM3U\n#EXT-X-KEY:${'A'.repeat(500_000)}\n#EXTINF:2,\na.ts\n`, BASE);
  assert.ok(performance.now() - t0 < 500, `took ${performance.now() - t0} ms`);
  assert.throws(() => parsePlaylist(`#EXTM3U\n${'#EXTINF:2,\na.ts\n'.repeat(120_000)}`, BASE), /too large/);
  const many = `#EXTM3U\n${Array.from({ length: 5000 }, (_, i) => `#EXT-X-STREAM-INF:BANDWIDTH=${i + 1}\nv${i}.m3u8`).join('\n')}`;
  assert.equal(parsePlaylist(many, BASE).variants.length, 2000, 'variants are capped');
  assert.ok(summarizePlaylist(parsePlaylist(many, BASE)).childUrls.length <= 500);
});

test('parseAttributes edge cases: unquoted values, quoted commas, missing values, odd spacing', () => {
  assert.deepEqual(parseAttributes('A=1,B="x,y",C=,D'), { A: '1', B: 'x,y', C: '' });
  assert.deepEqual(parseAttributes('lower=1,UPPER="2"'), { LOWER: '1', UPPER: '2' });
  assert.deepEqual(parseAttributes('A="unterminated'), { A: 'unterminated' });
  assert.deepEqual(parseAttributes('bad key=1,OK=2'), { OK: '2' });
});
