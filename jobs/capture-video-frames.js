'use strict';
/**
 * capture_video_frames — 1280x720 frames for the personalized video (brain assembles with FFmpeg).
 * payload: {
 *   prospect_id, video_id?, width?=1280, height?=720,
 *   frames: [{ name, url?, html?, selector?, wait_ms? }]   // html → title / CTA slides via page.setContent
 * }
 * Uploads PNGs with kind 'video_frame' (+ video_id); returns frames in order.
 */
const { JobError } = require('./_helpers');
const { captureTarget } = require('./capture-proof-screenshots');

module.exports = {
  type: 'capture_video_frames',
  platform: 'web',
  category: 'none',
  async run(ctx) {
    const { payload, page } = ctx;
    const frames = (Array.isArray(payload.frames) ? payload.frames : []).slice(0, 20);
    if (!frames.length) throw new JobError('missing_payload_fields:frames');
    const width = Number(payload.width) || 1280;
    const height = Number(payload.height) || 720;
    const shots = [];
    for (let i = 0; i < frames.length; i += 1) {
      ctx.progress(`frame_${i + 1}`, `frame ${i + 1}/${frames.length}`);
      const f = frames[i];
      // A failed frame breaks the video sequence → fail the job.
      const shot = await captureTarget(ctx, page, { ...f, width, height, full_page: false, name: f.name || `frame_${String(i + 1).padStart(2, '0')}` }, i);
      shots.push(shot);
    }
    ctx.progress('upload', `uploading ${shots.length} frame(s)`);
    const uploaded = await ctx.upload(shots, {
      kind: 'video_frame',
      prospect_id: payload.prospect_id || null,
      extra: payload.video_id ? { video_id: payload.video_id } : {},
    });
    return {
      data: {
        prospect_id: payload.prospect_id || null,
        video_id: payload.video_id || null,
        width,
        height,
        frames: shots.map((s, i) => ({
          index: i,
          name: s.name,
          url: uploaded[i] ? uploaded[i].url : null,
          path: uploaded[i] ? uploaded[i].path : null,
        })),
      },
    };
  },
};
