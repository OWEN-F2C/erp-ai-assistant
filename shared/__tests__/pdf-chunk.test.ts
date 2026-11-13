import { describe, it, expect } from 'vitest';
import { chunkLinesForPages } from '../../modules/purchase-plan-generator/pdf';

// 建议文本全部塞进单张 canvas 图片时，内容超过一页会被裁剪丢失；
// 分块后每块单独一页渲染。
describe('chunkLinesForPages', () => {
  it('空行列表 → 无分块', () => {
    expect(chunkLinesForPages([], 10, 10)).toEqual([]);
  });

  it('行数不足一页 → 单块', () => {
    expect(chunkLinesForPages(['a', 'b'], 5, 5)).toEqual([['a', 'b']]);
  });

  it('超过一页按容量切分', () => {
    const lines = ['1', '2', '3', '4', '5'];
    expect(chunkLinesForPages(lines, 2, 2)).toEqual([['1', '2'], ['3', '4'], ['5']]);
  });

  it('首页容量与后续页容量可以不同', () => {
    const lines = ['1', '2', '3', '4', '5', '6', '7'];
    expect(chunkLinesForPages(lines, 3, 2)).toEqual([['1', '2', '3'], ['4', '5'], ['6', '7']]);
  });

  it('容量至少为 1（防止死循环）', () => {
    expect(chunkLinesForPages(['a', 'b'], 0, 0)).toEqual([['a'], ['b']]);
  });
});
