// #C728: draws Time spent at a fixed clock, in the time zone the parent gave this process (TZ), and prints the chart's day
// labels and the "Today" tile's days as JSON. Run by tests/c728-parity-gaps.test.mjs in a child process, because a time zone
// can only be set before node starts.
import { drawPage } from "./draw-page.mjs";

const NOW = Number(process.env.C728_NOW);
const realNow = Date.now;
Date.now = () => NOW;
try {
  const usage = [{ id: "2027-02-01", day: "2027-02-01", runnerMin: 5 }];
  const { els } = drawPage({ usage }, { host: "store" });
  const labels = [...els.chart.innerHTML.matchAll(/text-anchor="middle">([0-9-]+)<\/text>/g)].map((m) => m[1]);
  process.stdout.write(JSON.stringify({ labels }));
} finally {
  Date.now = realNow;
}
