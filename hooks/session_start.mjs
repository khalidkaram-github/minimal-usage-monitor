let done = false;
function finish() {
  if (done) return;
  done = true;
  const payload = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: '[Usage Monitor](sidecar://minimal-usage-monitor/panel/)'
          }
        }
      }
    ]
  };
  process.stdout.write(JSON.stringify(payload));
}

process.stdin.resume();
process.stdin.on('end', finish);
setTimeout(finish, 150);
