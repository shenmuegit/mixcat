export async function openWorkflowCanvasMenu({ evaluate, poll, rpc }) {
  const point = await poll(() => evaluate(`(() => {
    const pane = document.querySelector('.session-workbench .react-flow__pane');
    if (!pane) return null;
    const bounds = pane.getBoundingClientRect();
    const x = bounds.left + 30;
    const y = bounds.top + 30;
    return document.elementFromPoint(x, y) === pane ? { x, y } : null;
  })()`));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await rpc('Input.dispatchMouseEvent', { type, ...point, button: 'right', clickCount: 1 });
  }
  await poll(() => evaluate("!!document.querySelector('[role=menu][aria-label=画布操作]')"));
}
