import { buildModal } from "../ui/modal";

function formatClock(totalSeconds: number): string {
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (totalSeconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Short beep via Web Audio — no audio asset needed. */
function playBeep() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  osc.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.2, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
  osc.start();
  osc.stop(ctx.currentTime + 0.6);
  osc.onended = () => ctx.close();
}

/**
 * A plain countdown timer, deliberately not wired to AW — for things like a
 * pomodoro break that shouldn't show up as tracked activity time. Keeps
 * ticking in the background via setInterval regardless of whether the modal
 * is open, so closing it doesn't pause the countdown.
 */
export function setupTimerModal(): { open: () => void } {
  const modal = buildModal("Timer");

  const durationInput = document.createElement("input");
  durationInput.id = "timer-duration-input";
  durationInput.type = "number";
  durationInput.min = "1";
  durationInput.value = "25";
  durationInput.title = "minutes";
  modal.body.appendChild(durationInput);

  const display = document.createElement("div");
  display.id = "timer-display";
  display.textContent = "25:00";
  modal.body.appendChild(display);

  const controls = document.createElement("div");
  controls.id = "timer-controls";
  modal.body.appendChild(controls);

  const startBtn = document.createElement("button");
  startBtn.textContent = "Start";
  controls.appendChild(startBtn);

  const pauseBtn = document.createElement("button");
  pauseBtn.textContent = "Pause";
  controls.appendChild(pauseBtn);

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset";
  controls.appendChild(resetBtn);

  let remainingSeconds = Number(durationInput.value) * 60;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function updateDisplay() {
    display.textContent = formatClock(remainingSeconds);
    display.classList.toggle("timer-done", remainingSeconds === 0 && intervalId === null);
  }

  function tick() {
    remainingSeconds -= 1;
    updateDisplay();
    if (remainingSeconds <= 0) {
      stop();
      playBeep();
    }
  }

  function stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    durationInput.disabled = false;
    updateDisplay();
  }

  startBtn.onclick = () => {
    if (intervalId !== null) return;
    if (remainingSeconds <= 0) remainingSeconds = Number(durationInput.value) * 60;
    if (remainingSeconds <= 0) return;
    durationInput.disabled = true;
    intervalId = setInterval(tick, 1000);
    updateDisplay();
  };

  pauseBtn.onclick = stop;

  resetBtn.onclick = () => {
    stop();
    remainingSeconds = Number(durationInput.value) * 60;
    updateDisplay();
  };

  durationInput.onchange = () => {
    if (intervalId === null) {
      remainingSeconds = Number(durationInput.value) * 60;
      updateDisplay();
    }
  };

  updateDisplay();

  return { open: modal.open };
}
