import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureFixtures, FIXTURE_DIR } from './helpers/fixtures.js';
import { parseXml, childOf, childrenOf } from '../extension/lib/xml.js';
import { readBoxes } from '../extension/lib/fmp4.js';
import {
  parseDuration, parseRange, expandTemplate, parseMpd, mainPeriod, videoRepresentations, audioRepresentations,
  representationLabel, representationExtension, resolveSegments, summarizeMpd,
} from '../extension/lib/dash.js';

ensureFixtures();
const CDN = 'http://cdn.test';
const fixture = (dir, name = 'index.mpd') => ({ text: readFileSync(join(FIXTURE_DIR, dir, name), 'utf8'), url: `${CDN}/${dir}/${name}` });
const load = (dir, name) => {
  const f = fixture(dir, name);
  return parseMpd(f.text, f.url);
};
const first = (mpd, type) => (type === 'video' ? videoRepresentations(mpd) : audioRepresentations(mpd))[0];

// ---- XML -------------------------------------------------------------------------------------------------------

test('xml: elements, attributes, text, CDATA, comments, prolog, namespaces and entities', () => {
  const root = parseXml(`﻿<?xml version="1.0"?>
    <!-- a comment -->
    <a:Root xmlns:a="urn:x" a:id="1" name='single &amp; "double"'>
      <Child n="1"/>
      <Child n="2">text &lt;b&gt; &#65;&#x42;</Child>
      <Data><![CDATA[<raw> & stuff]]></Data>
    </a:Root>`);
  assert.equal(root.name, 'Root');
  assert.deepEqual(root.attrs, { id: '1', name: 'single & "double"' });
  assert.equal(childrenOf(root, 'Child').length, 2);
  assert.equal(childrenOf(root, 'Child')[1].text, 'text <b> AB');
  assert.equal(childOf(root, 'Data').text, '<raw> & stuff');
});

test('xml: a ">" inside a quoted attribute value does not end the tag', () => {
  const root = parseXml('<a x="1>2" y=\'a>b\'><b/></a>');
  assert.equal(root.attrs.x, '1>2');
  assert.equal(root.attrs.y, 'a>b');
  assert.equal(root.children.length, 1);
});

test('xml: malformed or hostile documents are rejected', () => {
  for (const bad of [
    '<a><b></a>', // mismatched
    '<a>', // unclosed
    '<a/><b/>', // two roots
    'text', // no element
    '<a><!-- never closed </a>',
    '<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>', // internal subset (entity expansion)
    '<a><![CDATA[never closed</a>',
    '',
  ]) {
    assert.throws(() => parseXml(bad), Error, bad.slice(0, 30));
  }
  assert.throws(() => parseXml('<a>'.repeat(100) + '</a>'.repeat(100)), /nested too deeply/);
  assert.throws(() => parseXml('<a>' + 'x'.repeat(100) + '</a>', { maxChars: 50 }), /too large/);
  // A plain DOCTYPE without an internal subset is harmless.
  assert.equal(parseXml('<!DOCTYPE MPD><MPD/>').name, 'MPD');
  // Unknown entities are left as they are, never expanded.
  assert.equal(parseXml('<a>&custom;</a>').text, '&custom;');
});

// ---- small parsers ---------------------------------------------------------------------------------------------

test('parseDuration reads ISO 8601 durations', () => {
  assert.equal(parseDuration('PT12.0S'), 12);
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseDuration('P1DT2H'), 93600);
  assert.equal(parseDuration('PT0S'), 0);
  assert.equal(parseDuration('12 seconds'), null);
  assert.equal(parseDuration(undefined), null);
});

test('parseRange turns inclusive byte positions into offset+length', () => {
  assert.deepEqual(parseRange('836-17113'), { offset: 836, length: 16278 });
  assert.deepEqual(parseRange('0-0'), { offset: 0, length: 1 });
  assert.equal(parseRange('10-5'), null);
  assert.equal(parseRange('abc'), null);
  assert.equal(parseRange(undefined), null);
});

test('expandTemplate handles padding, $$ and unknown identifiers', () => {
  const v = { RepresentationID: 'v1', Number: 7, Time: 90000, Bandwidth: 800000 };
  assert.equal(expandTemplate('seg-$RepresentationID$-$Number%05d$.m4s', v), 'seg-v1-00007.m4s');
  assert.equal(expandTemplate('$Time$/$Bandwidth$/p$$q', v), '90000/800000/p$q');
  assert.equal(expandTemplate('$Number%03d$', { Number: 12345 }), '12345', 'padding never truncates');
  assert.equal(expandTemplate('$Unknown$', v), '$Unknown$');
  assert.equal(expandTemplate('init-$Number$.mp4', { RepresentationID: 'x' }), 'init-$Number$.mp4', 'init templates have no Number');
});

// ---- real ffmpeg manifests -------------------------------------------------------------------------------------

test('SegmentTemplate + SegmentTimeline (ffmpeg): init, segments, uneven audio durations', () => {
  const mpd = load('dash-tpl');
  assert.equal(mpd.type, 'static');
  assert.equal(mpd.duration, 12);
  assert.equal(mpd.protected, false);
  const v = resolveSegments(first(mpd, 'video'));
  assert.equal(v.init.url, `${CDN}/dash-tpl/init-stream0.m4s`);
  assert.equal(v.segments.length, 6);
  assert.equal(v.segments[0].url, `${CDN}/dash-tpl/chunk-stream0-00001.m4s`);
  assert.deepEqual(v.segments.map((s) => s.start), [0, 2, 4, 6, 8, 10]);
  const a = resolveSegments(first(mpd, 'audio'));
  assert.equal(a.segments.length, 7);
  assert.equal(a.segments.at(-1).url, `${CDN}/dash-tpl/chunk-stream1-00007.m4s`);
  assert.ok(Math.abs(a.segments[1].start - 84992 / 44100) < 1e-9);
  assert.ok(Math.abs(a.segments[1].duration - 88064 / 44100) < 1e-9);
  const total = a.segments.reduce((sum, s) => sum + s.duration, 0);
  assert.ok(Math.abs(total - 12) < 0.05, `audio covers ${total}s`);
});

test('SegmentList (ffmpeg): uniform durations from timescale/duration', () => {
  const v = resolveSegments(first(load('dash-list'), 'video'));
  assert.equal(v.init.url, `${CDN}/dash-list/init-stream0.m4s`);
  assert.equal(v.segments.length, 6);
  assert.deepEqual(v.segments.map((s) => s.start), [0, 2, 4, 6, 8, 10]);
  assert.equal(v.segments[5].url, `${CDN}/dash-list/chunk-stream0-00006.m4s`);
  assert.ok(v.segments.every((s) => s.range === null));
});

test('single file with byte ranges (ffmpeg): every segment is a slice of the BaseURL', () => {
  const mpd = load('dash-single');
  const v = resolveSegments(first(mpd, 'video'));
  const url = `${CDN}/dash-single/index-stream0.mp4`;
  assert.equal(v.single, false);
  assert.equal(v.segments.length, 6);
  assert.ok(v.segments.every((s) => s.url === url));
  assert.deepEqual(summarizeMpd(mpd).childUrls.sort(), [url, `${CDN}/dash-single/index-stream1.mp4`]);

  // The expected ranges come from the file itself (byte counts differ between ffmpeg builds): the init segment is
  // ftyp + moov, and each media segment runs from one sidx box to the next, tiling the file without gaps.
  const file = new Uint8Array(readFileSync(join(FIXTURE_DIR, 'dash-single', 'index-stream0.mp4')));
  const boxes = [...readBoxes(file)];
  const moov = boxes.find((b) => b.type === 'moov');
  const starts = boxes.filter((b) => b.type === 'sidx').map((b) => b.start);
  assert.equal(starts.length, 6, 'the fixture has one sidx per segment');
  assert.deepEqual(v.init, { url, range: { offset: 0, length: moov.end } });
  assert.deepEqual(
    v.segments.map((s) => [s.range.offset, s.range.offset + s.range.length]),
    starts.map((start, i) => [start, starts[i + 1] ?? file.length]),
  );
});

test('duration-based SegmentTemplate with $Number$', () => {
  const v = resolveSegments(first(load('dash-tpl', 'number.mpd'), 'video'));
  assert.equal(v.segments.length, 6);
  assert.deepEqual(v.segments.map((s) => s.number), [1, 2, 3, 4, 5, 6]);
  assert.equal(v.segments[2].url, `${CDN}/dash-tpl/chunk-stream0-00003.m4s`);
  assert.equal(v.segments[2].start, 4);
});

test('several qualities: video sorted best first, labels, audio listed separately', () => {
  const mpd = load('dash-multi');
  const video = videoRepresentations(mpd);
  assert.deepEqual(video.map((r) => r.height), [360, 180]);
  assert.match(representationLabel(video[0]), /^360p · \d+ kbps$/);
  const audio = audioRepresentations(mpd);
  assert.equal(audio.length, 1);
  assert.match(representationLabel(audio[0]), /mp4a · 69 kbps/);
  assert.equal(representationExtension(video[0]), '.mp4');
  assert.equal(representationExtension(audio[0]), '.m4a');
  const s = summarizeMpd(mpd);
  assert.equal(s.variants, 2);
  assert.equal(s.maxHeight, 360);
  assert.equal(s.duration, 12);
  assert.equal(s.live, false);
  assert.equal(s.unsupported, '');
});

test('WebM representations are recognised so they are saved as .webm and never merged', () => {
  const mpd = load('dash-webm');
  assert.equal(first(mpd, 'video').container, 'webm');
  assert.equal(representationExtension(first(mpd, 'video')), '.webm');
  assert.equal(representationExtension(first(mpd, 'audio')), '.weba');
  assert.equal(resolveSegments(first(mpd, 'video')).segments.length, 6);
});

test('ContentProtection on everything marks the manifest as DRM and names the system; nothing is offered', () => {
  const mpd = load('dash-tpl', 'drm.mpd');
  assert.equal(mpd.protected, true);
  assert.deepEqual(mpd.drmSystems, ['Widevine']);
  assert.equal(videoRepresentations(mpd).length + audioRepresentations(mpd).length, 0, 'protected renditions are never offered');
  const s = summarizeMpd(mpd);
  assert.equal(s.drm, true);
  assert.deepEqual(s.drmSystems, ['Widevine']);
  assert.match(s.unsupported, /DRM-protected \(Widevine\)/);
  assert.equal(load('dash-tpl').protected, false);
});

test('partly protected manifest: the clear renditions stay available, the protected ones are left out', () => {
  const mpd = load('dash-multi', 'partial-drm.mpd');
  assert.equal(mpd.protected, false, 'DRM only decides when it covers everything');
  assert.equal(mpd.hiddenProtected, 1);
  assert.deepEqual(videoRepresentations(mpd).map((r) => r.height), [180], 'the 360p rendition is protected');
  assert.equal(audioRepresentations(mpd).length, 1);
  const s = summarizeMpd(mpd);
  assert.equal(s.drm, false);
  assert.equal(s.unsupported, '');
  assert.equal(s.hiddenProtected, 1);
  assert.equal(s.maxHeight, 180);
});

test('protected video with clear audio: only the audio is offered', () => {
  const mpd = parseMpd(
    `<MPD type="static" mediaPresentationDuration="PT4S"><Period>
       <AdaptationSet contentType="video" mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2"/><Representation id="v" bandwidth="1" height="1080"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet>
       <AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="a" bandwidth="1"><BaseURL>a.mp4</BaseURL></Representation></AdaptationSet>
     </Period></MPD>`,
    `${CDN}/m.mpd`,
  );
  assert.equal(mpd.protected, false);
  assert.equal(videoRepresentations(mpd).length, 0);
  assert.equal(audioRepresentations(mpd).length, 1);
  assert.equal(summarizeMpd(mpd).audioOnly, true);
});

test('only http(s) URLs are accepted in a manifest', () => {
  const mpd = (base) => `<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1"><BaseURL>${base}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
  for (const bad of ['file:///C:/x.mp4', 'data:video/mp4;base64,AAAA', 'chrome-extension://abc/x.mp4', 'ftp://h/x.mp4']) {
    assert.throws(() => parseMpd(mpd(bad), `${CDN}/m.mpd`), /Unsupported URL scheme/, bad);
  }
});

test('hostile manifests are bounded: huge repeat counts, many elements, long attribute-free runs', () => {
  const huge = parseMpd(
    '<MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1"><SegmentTemplate timescale="1" media="s$Number$.m4s"><SegmentTimeline><S t="0" d="1" r="4000000"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>',
    `${CDN}/m.mpd`,
  );
  const t0 = performance.now();
  assert.throws(() => resolveSegments(videoRepresentations(huge)[0]), /too many segments/);
  assert.match(summarizeMpd(huge).unsupported, /too many segments|Could not read/);
  const numbered = parseMpd(
    '<MPD type="static" mediaPresentationDuration="P100000D"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1"><SegmentTemplate timescale="1000" duration="1" media="s$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>',
    `${CDN}/m.mpd`,
  );
  assert.throws(() => resolveSegments(videoRepresentations(numbered)[0]), /too many segments/);
  assert.throws(() => parseXml(`<a>${'<b/>'.repeat(250_000)}</a>`), /too many elements/);
  parseXml(`<a ${'x'.repeat(300_000)}="1" ${'y '.repeat(100_000)}/>`);
  parseXml(`<a ${'='.repeat(100_000)}/>`);
  assert.ok(performance.now() - t0 < 2000, `took ${performance.now() - t0} ms`);
});

test('dynamic manifests: a SegmentTimeline is downloadable, wall-clock numbering is refused', () => {
  const live = load('dash-tpl', 'live.mpd');
  assert.equal(live.type, 'dynamic');
  assert.equal(resolveSegments(first(live, 'video'), live.type).segments.length, 6);
  assert.equal(summarizeMpd(live).live, true);

  const numbered = parseMpd(
    '<MPD type="dynamic"><Period><AdaptationSet contentType="video"><Representation id="v" mimeType="video/mp4" bandwidth="1"><SegmentTemplate duration="2" media="s$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>',
    `${CDN}/live.mpd`,
  );
  const r = resolveSegments(first(numbered, 'video'), numbered.type);
  assert.match(r.error, /wall-clock/);
  assert.match(summarizeMpd(numbered).unsupported, /wall-clock/);
});

// ---- hand-written edge cases -----------------------------------------------------------------------------------

test('inheritance: SegmentTemplate on the AdaptationSet, overridden per Representation; BaseURL chain', () => {
  const mpd = parseMpd(
    `<MPD type="static" mediaPresentationDuration="PT8S">
       <BaseURL>https://cdn.example/root/</BaseURL>
       <Period>
         <BaseURL>p1/</BaseURL>
         <AdaptationSet contentType="video" mimeType="video/mp4">
           <BaseURL>video/</BaseURL>
           <SegmentTemplate timescale="1000" duration="4000" startNumber="0" media="$RepresentationID$/s-$Number$.m4s" initialization="$RepresentationID$/init.mp4"/>
           <Representation id="hi" bandwidth="2000000" width="1280" height="720"/>
           <Representation id="lo" bandwidth="500000" width="640" height="360"><SegmentTemplate startNumber="10"/></Representation>
         </AdaptationSet>
       </Period>
     </MPD>`,
    'https://origin.example/manifest.mpd',
  );
  const [hi, lo] = videoRepresentations(mpd);
  assert.equal(hi.id, 'hi');
  const a = resolveSegments(hi);
  assert.equal(a.init.url, 'https://cdn.example/root/p1/video/hi/init.mp4');
  assert.deepEqual(a.segments.map((s) => s.url), ['https://cdn.example/root/p1/video/hi/s-0.m4s', 'https://cdn.example/root/p1/video/hi/s-1.m4s']);
  const b = resolveSegments(lo);
  assert.deepEqual(b.segments.map((s) => s.number), [10, 11], 'the Representation overrides startNumber but inherits the rest');
  assert.equal(b.segments[0].url, 'https://cdn.example/root/p1/video/lo/s-10.m4s');
});

test('SegmentTimeline: $Time$ addressing, presentationTimeOffset, r="-1" repeats until the period ends', () => {
  const mpd = parseMpd(
    `<MPD type="static"><Period duration="PT10S"><AdaptationSet contentType="video" mimeType="video/mp4">
       <Representation id="v" bandwidth="1" width="2" height="2">
         <SegmentTemplate timescale="100" presentationTimeOffset="50" media="t-$Time$.m4s" initialization="i.mp4">
           <SegmentTimeline><S t="50" d="200" r="-1"/></SegmentTimeline>
         </SegmentTemplate>
       </Representation></AdaptationSet></Period></MPD>`,
    `${CDN}/m.mpd`,
  );
  const r = resolveSegments(first(mpd, 'video'));
  // 10 s of media at 2 s per segment = 5 segments, times offset by the PTO.
  assert.deepEqual(r.segments.map((s) => s.url.split('/').pop()), ['t-50.m4s', 't-250.m4s', 't-450.m4s', 't-650.m4s', 't-850.m4s']);
  assert.deepEqual(r.segments.map((s) => s.start), [0, 2, 4, 6, 8]);
});

test('an open-ended timeline in a dynamic manifest is flagged instead of guessed', () => {
  const mpd = parseMpd(
    `<MPD type="dynamic"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1">
       <SegmentTemplate timescale="1" media="s$Number$.m4s"><SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate>
     </Representation></AdaptationSet></Period></MPD>`,
    `${CDN}/m.mpd`,
  );
  const r = resolveSegments(first(mpd, 'video'), 'dynamic');
  assert.equal(r.openEnded, true);
  assert.equal(r.segments.length, 1);
});

test('multi-period: the longest period is the one that is downloaded', () => {
  const mpd = parseMpd(
    `<MPD type="static" mediaPresentationDuration="PT130S">
       <Period id="ad" start="PT0S" duration="PT10S"><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="ad" bandwidth="1" height="360"><BaseURL>ad.mp4</BaseURL></Representation></AdaptationSet></Period>
       <Period id="main" start="PT10S"><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="main" bandwidth="1" height="1080"><BaseURL>main.mp4</BaseURL></Representation></AdaptationSet></Period>
     </MPD>`,
    `${CDN}/m.mpd`,
  );
  assert.equal(mainPeriod(mpd).index, 1);
  assert.equal(mainPeriod(mpd).duration, 120);
  assert.equal(videoRepresentations(mpd)[0].id, 'main');
  const s = summarizeMpd(mpd);
  assert.equal(s.periods, 2);
  assert.equal(s.duration, 120);
  assert.equal(s.maxHeight, 1080);
});

test('a representation with only a BaseURL is one file; subtitles and unknown types are not offered as video/audio', () => {
  const mpd = parseMpd(
    `<MPD type="static"><Period>
       <AdaptationSet mimeType="audio/mp4" lang="en"><Representation id="a" bandwidth="128000" codecs="mp4a.40.2"><BaseURL>audio_en.mp4</BaseURL><SegmentBase indexRange="800-1000"><Initialization range="0-799"/></SegmentBase></Representation></AdaptationSet>
       <AdaptationSet mimeType="application/ttml+xml" lang="en"><Representation id="t"><BaseURL>subs.xml</BaseURL></Representation></AdaptationSet>
     </Period></MPD>`,
    `${CDN}/m.mpd`,
  );
  assert.equal(videoRepresentations(mpd).length, 0);
  const [a] = audioRepresentations(mpd);
  assert.deepEqual(resolveSegments(a), { single: true, url: `${CDN}/audio_en.mp4`, init: null, segments: [] });
  assert.equal(representationLabel(a), 'en · mp4a · 128 kbps');
  const s = summarizeMpd(mpd);
  assert.equal(s.audioOnly, true);
  assert.equal(s.maxHeight, null);
});

test('not an MPD, or an MPD with nothing to download', () => {
  assert.throws(() => parseMpd('<html></html>', `${CDN}/x`), /Not a DASH manifest/);
  assert.throws(() => parseMpd('not xml at all', `${CDN}/x`));
  const empty = parseMpd('<MPD type="static"><Period/></MPD>', `${CDN}/x`);
  assert.match(summarizeMpd(empty).unsupported, /no downloadable/);
});
