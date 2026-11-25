// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from 'vue'
import { expect, it, vi } from 'vitest'
import { Position, type EdgeProps } from '@vue-flow/core'
import ForestEdge from '../src/canvas/ForestEdge.vue'
it('树箭头按实际路径长度居中，四个方向跟随切线，图保留原箭头和命中路径', async () => {
  const state = reactive({
    midpointArrow: true,
    targetX: 500,
    targetY: 100,
    sourceSide: Position.Right,
    targetSide: Position.Left,
  })
  // Happy DOM exposes the geometry API but cannot measure SVG paths.
  const measure = vi.spyOn(SVGPathElement.prototype, 'getTotalLength').mockReturnValue(400)
  const point = vi.spyOn(SVGPathElement.prototype, 'getPointAtLength').mockImplementation(function (
    this: SVGPathElement,
    distance,
  ) {
    const values = this.getAttribute('d')!
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number)
    const [endX, endY] = values.slice(-2)
    const point = new DOMPoint(
      100 + ((endX - 100) * distance) / 400,
      100 + ((endY - 100) * distance) / 400,
    )
    return point as SVGPoint
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () =>
      h('svg', [
        h(ForestEdge, {
          id: 'edge-test',
          source: 'parent',
          target: 'child',
          type: 'forest',
          sourceNode: {} as EdgeProps['sourceNode'],
          targetNode: {} as EdgeProps['targetNode'],
          events: {} as EdgeProps['events'],
          sourceX: 100,
          sourceY: 100,
          targetX: state.targetX,
          targetY: state.targetY,
          sourcePosition: state.sourceSide,
          targetPosition: state.targetSide,
          markerStart: '',
          markerEnd: state.midpointArrow ? '' : 'url(#graph-arrow)',
          interactionWidth: 12,
          data: { color: '#6599cb', midpointArrow: state.midpointArrow },
        }),
      ]),
  })
  try {
    app.mount(host)
    await nextTick()
    const baseline = () => host.querySelector<SVGPathElement>('.vue-flow__edge-path')!,
      arrow = () => host.querySelector<SVGPolygonElement>('.tree-edge-arrow')
    expect(arrow()?.getAttribute('pointer-events')).toBe('none')
    expect(arrow()?.getAttribute('fill')).toBe(baseline().style.stroke)
    expect(host.querySelector('.vue-flow__edge-interaction')?.getAttribute('stroke-width')).toBe(
      '12',
    )
    const layouts: [number, number, Position, Position, string][] = [
      [500, 100, Position.Right, Position.Left, 'translate(300 100) rotate(0)'],
      [100, 500, Position.Bottom, Position.Top, 'translate(100 300) rotate(90)'],
      [-300, 100, Position.Left, Position.Right, 'translate(-100 100) rotate(180)'],
      [100, -300, Position.Top, Position.Bottom, 'translate(100 -100) rotate(-90)'],
    ]
    for (const [x, y, source, target, transform] of layouts) {
      Object.assign(state, { targetX: x, targetY: y, sourceSide: source, targetSide: target })
      await nextTick()
      expect(arrow()?.getAttribute('transform')).toBe(transform)
      expect(point.mock.calls.slice(-3)).toEqual([[200], [199], [201]])
    }
    state.midpointArrow = false
    await nextTick()
    expect(arrow()).toBeNull()
    expect(baseline().getAttribute('marker-end')).toBe('url(#graph-arrow)')
    expect(host.querySelector('.vue-flow__edge-interaction')).not.toBeNull()
  } finally {
    measure.mockRestore()
    point.mockRestore()
    app.unmount()
    host.remove()
  }
})
