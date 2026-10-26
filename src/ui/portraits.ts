import type { Survivor } from '../sim/types';
import { roleColor } from '../render/sprites';

// Small painted portraits, generated once per survivor.

const cache = new Map<string, string>();

export function portrait(s: Survivor): string {
  const hit = cache.get(s.id);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const ctx = c.getContext('2d')!;
  const bg = ctx.createLinearGradient(0, 0, 0, 96);
  bg.addColorStop(0, '#3a332b');
  bg.addColorStop(1, '#1e1a16');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = roleColor(s.role);
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.arc(48, 40, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // Shoulders
  ctx.fillStyle = s.look.shirt;
  ctx.beginPath();
  ctx.moveTo(10, 96);
  ctx.quadraticCurveTo(14, 66, 48, 64);
  ctx.quadraticCurveTo(82, 66, 86, 96);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(46, 66, 4, 30);
  // Neck & head
  ctx.fillStyle = s.look.skin;
  ctx.fillRect(40, 54, 16, 14);
  ctx.beginPath();
  ctx.ellipse(48, 40, 17, 20, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  ctx.ellipse(56, 42, 8, 17, 0, -Math.PI / 2, Math.PI / 2);
  ctx.fill();
  // Eyes
  ctx.fillStyle = '#1b1612';
  ctx.fillRect(40, 39, 4, 2.6);
  ctx.fillRect(52, 39, 4, 2.6);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(43, 50, 10, 1.6);
  // Hair
  ctx.fillStyle = s.look.hair;
  ctx.beginPath();
  switch (s.look.hairStyle) {
    case 0:
      ctx.ellipse(48, 28, 18, 11, 0, Math.PI, Math.PI * 2);
      ctx.rect(30, 26, 36, 5);
      break;
    case 1:
      ctx.ellipse(48, 28, 19, 13, 0, Math.PI * 0.95, Math.PI * 2.05);
      ctx.moveTo(30, 30);
      ctx.quadraticCurveTo(26, 50, 34, 58);
      ctx.lineTo(34, 32);
      break;
    case 2:
      ctx.ellipse(48, 30, 21, 15, 0, Math.PI * 0.9, Math.PI * 2.1);
      ctx.moveTo(28, 34);
      ctx.quadraticCurveTo(24, 58, 32, 66);
      ctx.lineTo(34, 34);
      ctx.moveTo(68, 34);
      ctx.quadraticCurveTo(72, 58, 64, 66);
      ctx.lineTo(62, 34);
      break;
    default:
      ctx.ellipse(48, 24, 16, 6, 0, Math.PI, Math.PI * 2);
  }
  ctx.fill();
  // Role band
  ctx.fillStyle = roleColor(s.role);
  ctx.fillRect(0, 90, 96, 6);
  const url = c.toDataURL();
  cache.set(s.id, url);
  return url;
}
