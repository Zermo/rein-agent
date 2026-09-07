// Failed spawn emits close, not exit. Waiting for close also drains the child's pipes.
export async function stopChild(child, delay = 3000) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), delay);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
