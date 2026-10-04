import { describe, it, expect } from "vitest";
import { parseFfmpegBanner, extractFfmpegError } from "../src/lib/mediaService.js";

const VIDEO_BANNER = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Metadata:
    encoder         : Lavf
  Duration: 00:00:10.00, start: 0.000000, bitrate: 500 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), 1280x720, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo, fltp
`;

const SILENT_VIDEO_BANNER = `Input #0, mov,mp4 from 'silent.mp4':
  Duration: 00:00:06.00, bitrate: 200 kb/s
  Stream #0:0: Video: h264, 640x480
`;

const AUDIO_BANNER = `Input #0, mov, from 'tone.m4a':
  Duration: 00:00:02.00, bitrate: 128 kb/s
  Stream #0:0: Audio: aac (LC), 44100 Hz, mono
`;

describe("parseFfmpegBanner", () => {
  it("识别带音轨视频的分辨率/时长/音轨", () => {
    const p = parseFfmpegBanner(VIDEO_BANNER);
    expect(p.mediaType).toBe("video");
    expect(p.hasAudio).toBe(true);
    expect(p.hasVideo).toBe(true);
    expect(p.width).toBe(1280);
    expect(p.height).toBe(720);
    expect(p.durationMs).toBe(10000);
  });

  it("无音轨视频标记 hasAudio=false（关键：不能误判为有音轨）", () => {
    const p = parseFfmpegBanner(SILENT_VIDEO_BANNER);
    expect(p.mediaType).toBe("video");
    expect(p.hasAudio).toBe(false);
    expect(p.width).toBe(640);
  });

  it("识别纯音频", () => {
    const p = parseFfmpegBanner(AUDIO_BANNER);
    expect(p.mediaType).toBe("audio");
    expect(p.hasAudio).toBe(true);
    expect(p.hasVideo).toBe(false);
  });
});

describe("extractFfmpegError", () => {
  it("从冗长 banner 中提取核心错误", () => {
    const raw = "ffmpeg 退出码 183；日志尾部：ffmpeg version 7\nmoov atom not found\nError opening input: Invalid data found";
    const out = extractFfmpegError(raw);
    expect(out).toMatch(/moov atom not found|Invalid data/);
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
