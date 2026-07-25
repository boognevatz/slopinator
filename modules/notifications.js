var _intervalId = null;

function cleanup() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
}

export function showNotification(msg, seconds, isError) {
  var el = document.getElementById('notification');
  if (!el) return;
  cleanup();

  el.classList.toggle('error', !!isError);
  document.getElementById('notification-text').textContent = msg || '';
  document.getElementById('notification-countdown').textContent = '';
  el.hidden = false;

  if (seconds > 0) {
    var count = seconds;
    var countEl = document.getElementById('notification-countdown');
    countEl.textContent = ' (will disappear in ' + count + 's)';
    _intervalId = setInterval(function() {
      count--;
      countEl.textContent = ' (will disappear in ' + count + 's)';
      if (count <= 0) hideNotification();
    }, 1000);
  }
}

export function hideNotification() {
  cleanup();
  var el = document.getElementById('notification');
  if (el) el.hidden = true;
}

document.getElementById('notification-close').addEventListener('click', hideNotification);
document.getElementById('editor-svg').addEventListener('pointerdown', hideNotification, { capture: true });
