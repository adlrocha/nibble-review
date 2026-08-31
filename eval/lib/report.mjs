import { escapeHtml } from "./text.mjs";

function formatTokens(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(Number(value) || 0));
}

function sortValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return String(value).toLowerCase();
}

function modelLabel(model) {
  const value = String(model || "");
  return (value.split("/").pop() || value).replace(/(?::free|-free)$/u, "");
}

function statusClass(status) {
  if (status === "passed") {
    return "ok";
  }
  if (status === "pending judge") {
    return "pending";
  }
  return "bad";
}

function scoreCell(result) {
  if (result.scorePercent === null || result.scorePercent === undefined) {
    return `<span class="muted">n/a</span>`;
  }
  return `<div class="score">
    <div class="score-number">${escapeHtml(result.scoreLabel)}</div>
    <div class="bar"><span style="width: ${escapeHtml(result.scorePercent)}%"></span></div>
  </div>`;
}

function artifactLinks(files) {
  return Object.entries(files || {})
    .filter(([, path]) => path)
    .map(([label, path]) => `<a href="${escapeHtml(path)}">${escapeHtml(label)}</a>`)
    .join(" ");
}

function failureItems(result) {
  const error = String(result.error || "").trim();
  if (error) {
    return [error];
  }
  return (result.hardFailures || [])
    .map((failure) => {
      const label = failure.label || failure.id || "";
      return failure.value ? `${label}: ${failure.value}` : label;
    })
    .filter(Boolean);
}

function heuristicsList(heuristics) {
  return (heuristics || [])
    .map((check) => {
      const state =
        check.passed === true ? "pass" : check.passed === false ? (check.hard ? "hard fail" : "miss") : "n/a";
      const value = [check.value, check.limit ? `limit ${check.limit}` : ""].filter(Boolean).join(" / ");
      return `<li>
        <span class="pill ${check.passed === false ? "bad" : "ok"}">${escapeHtml(state)}</span>
        <strong>${escapeHtml(check.label)}</strong>
        ${value ? `<span class="muted">${escapeHtml(value)}</span>` : ""}
      </li>`;
    })
    .join("");
}

function listItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<p class="muted">None recorded.</p>`;
  }
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function judgeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return `<p class="muted">No judge questions recorded. Rerun the judge to populate this section.</p>`;
  }
  return `<table class="nested">
    <thead>
      <tr>
        <th>Score</th>
        <th>Question</th>
        <th>Judge answer</th>
      </tr>
    </thead>
    <tbody>
      ${questions
        .map(
          (question) => `<tr>
            <td>${escapeHtml(question.scoreLabel || "n/a")}</td>
            <td>
              ${question.id ? `<strong>${escapeHtml(question.id)}</strong><br>` : ""}
              ${escapeHtml(question.question)}
            </td>
            <td>
              ${escapeHtml(question.answer || question.reason || "")}
              ${question.result ? `<div class="muted">result: ${escapeHtml(question.result)}</div>` : ""}
              ${question.evidence ? `<div class="muted">evidence: ${escapeHtml(question.evidence)}</div>` : ""}
            </td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function detailPanel(result) {
  return `<details>
    <summary>details</summary>
    <div class="detail-grid">
      <section>
        <h3>Judge</h3>
        <p><strong>${escapeHtml(result.scoreLabel)}</strong> ${escapeHtml(result.verdictLabel || "")}</p>
        <p>${escapeHtml(result.reason || "No judge reason recorded.")}</p>
      </section>
      <section>
        <h3>Judge questions</h3>
        <div class="qa">${judgeQuestions(result.questions || result.answers)}</div>
      </section>
      <section>
        <h3>Usage</h3>
        <dl>
          <dt>Capture tokens</dt><dd>${formatTokens(result.captureUsage.totalTokens)}</dd>
          <dt>Judge tokens</dt><dd>${formatTokens(result.judgeUsage.totalTokens)}</dd>
          <dt>Total tokens</dt><dd>${formatTokens(result.usage.totalTokens)}</dd>
          <dt>Input</dt><dd>${formatTokens(result.usage.inputTokens)}</dd>
          <dt>Output</dt><dd>${formatTokens(result.usage.outputTokens)}</dd>
          <dt>Reasoning</dt><dd>${formatTokens(result.usage.reasoningTokens)}</dd>
          <dt>Cache read</dt><dd>${formatTokens(result.usage.cacheReadTokens)}</dd>
          <dt>Review cost</dt><dd>${escapeHtml(result.costLabel || result.reportedCostLabel)}</dd>
          <dt>Judge cost</dt><dd>${escapeHtml(result.judgeCostLabel || result.judgeReportedCostLabel || "n/a")}</dd>
          <dt>Total cost</dt><dd>${escapeHtml(result.totalReportedCostLabel || result.reportedCostLabel)}</dd>
          <dt>Comments</dt><dd>${formatTokens(result.producedComments)}</dd>
          <dt>Inline</dt><dd>${formatTokens(result.commentCounts?.inline)}</dd>
          <dt>Replies</dt><dd>${formatTokens(result.commentCounts?.replies)}</dd>
          <dt>Dropped</dt><dd>${formatTokens(result.commentCounts?.dropped)}</dd>
          <dt>Capture wall time</dt><dd>${escapeHtml(result.captureDurationLabel || "n/a")}</dd>
          <dt>Reviewer timing</dt><dd>${escapeHtml(result.reviewerDurationLabel || result.durationLabel || "n/a")}</dd>
          <dt>Reviewer boundary</dt><dd>${escapeHtml(result.reviewerDurationBoundary || "legacy")}</dd>
        </dl>
      </section>
      <section>
        <h3>Artifacts</h3>
        <p class="links">${artifactLinks(result.files)}</p>
      </section>
      <section>
        <h3>Heuristics</h3>
        <ul class="heuristics">${heuristicsList(result.heuristics)}</ul>
      </section>
    </div>
    <h3>Strengths</h3>
    ${listItems(result.strengths)}
    <h3>Risks</h3>
    ${listItems(result.risks)}
    <h3>Review</h3>
    <pre>${escapeHtml(result.reviewText || "No review output captured.")}</pre>
  </details>`;
}

function rows(results) {
  return results
    .map((result) => {
      const failures = failureItems(result);
      return `<tr class="result-row">
        <td data-sort="${escapeHtml(sortValue(result.pr))}">
          <div><strong>${escapeHtml(result.pr)}</strong></div>
          ${result.label ? `<div class="muted">${escapeHtml(result.label)}</div>` : ""}
        </td>
        <td data-sort="${escapeHtml(sortValue(result.model))}"><code>${escapeHtml(modelLabel(result.model))}</code></td>
        <td data-sort="${escapeHtml(sortValue(result.status))}"><span class="pill ${statusClass(result.status)}">${escapeHtml(result.status)}</span></td>
        <td data-sort="${result.scorePercent ?? -1}">${scoreCell(result)}</td>
        <td data-sort="${escapeHtml(sortValue(result.verdictKey))}">${escapeHtml(result.verdictLabel || "n/a")}</td>
        <td data-sort="${result.captureDurationMs ?? -1}">${escapeHtml(result.captureDurationLabel || "n/a")}</td>
        <td data-sort="${result.reviewerDurationMs ?? result.durationMs ?? -1}">${escapeHtml(result.reviewerDurationLabel || result.durationLabel || "n/a")}</td>
        <td data-sort="${result.usage.totalTokens}">${formatTokens(result.usage.totalTokens)}</td>
        <td data-sort="${result.costUsd ?? result.reportedCostUsd}">${escapeHtml(result.costLabel || result.reportedCostLabel)}</td>
        <td data-sort="${failures.length}">${escapeHtml(failures.join(", "))}</td>
      </tr>
      <tr class="detail-row">
        <td colspan="10">${detailPanel(result)}</td>
      </tr>`;
    })
    .join("\n");
}

function kpi(label, value, subvalue = "") {
  return `<div class="kpi">
    <div class="kpi-label">${escapeHtml(label)}</div>
    <div class="kpi-value">${escapeHtml(value)}</div>
    ${subvalue ? `<div class="kpi-sub">${escapeHtml(subvalue)}</div>` : ""}
  </div>`;
}

export function renderReport(summary) {
  const totals = summary.totals;
  const resultRows = rows(summary.results || []);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Nibble Review Eval</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: Inter, ui-sans-serif, system-ui, sans-serif; margin: 0; color: #111827; background: #f8fafc; }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 28px 0 12px; font-size: 18px; letter-spacing: 0; }
    h3 { margin: 18px 0 8px; font-size: 14px; letter-spacing: 0; }
    p { line-height: 1.5; }
    table { border-collapse: collapse; width: 100%; background: white; border: 1px solid #e5e7eb; table-layout: fixed; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 10px; text-align: left; vertical-align: top; font-size: 13px; overflow-wrap: anywhere; }
    th { background: #f3f4f6; color: #374151; font-weight: 600; cursor: pointer; user-select: none; }
    th.sort-asc::after { content: " asc"; color: #6b7280; font-weight: 500; }
    th.sort-desc::after { content: " desc"; color: #6b7280; font-weight: 500; }
    code { background: #f3f4f6; padding: 2px 4px; border-radius: 3px; white-space: normal; }
    pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 520px; padding: 12px; background: #0f172a; color: #e5e7eb; border-radius: 6px; line-height: 1.45; }
    a { color: #0f766e; text-decoration: none; }
    a:hover { text-decoration: underline; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0; }
    dt { color: #6b7280; }
    dd { margin: 0; font-weight: 600; }
    summary { cursor: pointer; font-weight: 600; color: #0f766e; }
    .subtitle { margin: 0 0 20px; color: #4b5563; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 20px 0; }
    .kpi { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px; }
    .kpi-label { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .kpi-value { margin-top: 6px; font-size: 24px; font-weight: 700; }
    .kpi-sub { margin-top: 4px; color: #6b7280; font-size: 12px; }
    .muted { color: #6b7280; }
    .pill { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 700; }
    .pill.ok { background: #dcfce7; color: #166534; }
    .pill.pending { background: #fef9c3; color: #854d0e; }
    .pill.bad { background: #fee2e2; color: #991b1b; }
    .score-number { font-weight: 700; margin-bottom: 4px; }
    .bar { width: 92px; height: 7px; background: #e5e7eb; border-radius: 999px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: #0f766e; }
    .detail-row td { background: #fbfdff; }
    details { max-width: 100%; }
    .detail-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin: 12px 0; }
    .detail-grid section { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; min-height: 0; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; }
    .heuristics { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
    .heuristics li { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  </style>
</head>
<body>
  <main>
    <h1>Nibble Review Eval</h1>
    <p class="subtitle">Run ${escapeHtml(summary.run.startedAt || "")} to ${escapeHtml(summary.run.endedAt || "")}. Capture wall time excludes cache hits; reviewer timing follows each implementation's own internal boundary.</p>
    <section class="kpis">
      ${kpi("Run OK", `${totals.passed}/${totals.jobs}`, `${totals.hardFailed} hard failed`)}
      ${kpi("Average score", totals.averageScoreLabel)}
      ${kpi("Comments", String(totals.producedComments))}
      ${kpi("Run wall time", summary.run.durationLabel)}
      ${kpi("Tokens", totals.usageLabels.totalTokens, `${totals.usageLabels.inputTokens} input / ${totals.usageLabels.outputTokens} output`)}
      ${kpi("Reasoning", totals.usageLabels.reasoningTokens, `${totals.usageLabels.cacheReadTokens} cache read`)}
      ${kpi("Review Cost", totals.usageLabels.reportedCostUsd, `${totals.usageLabels.judgeReportedCostUsd} judge`)}
    </section>
    <h2>Results</h2>
    <table class="sortable">
      <thead>
        <tr>
          <th>PR</th>
          <th>Model</th>
          <th>Status</th>
          <th>Score</th>
          <th>Verdict</th>
          <th>Capture wall</th>
          <th>Reviewer timing</th>
          <th>Tokens</th>
          <th>Cost</th>
          <th>Failures</th>
        </tr>
      </thead>
      <tbody>${resultRows}</tbody>
    </table>
  </main>
  <script>
    function cellValue(row, index) {
      const cell = row.children[index];
      const value = cell && cell.dataset ? cell.dataset.sort : "";
      const number = Number(value);
      return Number.isFinite(number) && value.trim() !== "" ? number : String(value || cell.textContent).toLowerCase();
    }

    for (const table of document.querySelectorAll("table.sortable")) {
      for (const [index, header] of Array.from(table.tHead.rows[0].children).entries()) {
        header.addEventListener("click", () => {
          const direction = header.classList.contains("sort-asc") ? -1 : 1;
          for (const th of table.querySelectorAll("th")) {
            th.classList.remove("sort-asc", "sort-desc");
          }
          header.classList.add(direction === 1 ? "sort-asc" : "sort-desc");

          const groups = [];
          const rows = Array.from(table.tBodies[0].rows);
          for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            const row = rows[rowIndex];
            if (!row.classList.contains("result-row")) {
              continue;
            }
            groups.push({
              row,
              detail: rows[rowIndex + 1]?.classList.contains("detail-row") ? rows[rowIndex + 1] : null,
              value: cellValue(row, index),
            });
          }

          groups.sort((left, right) => {
            const a = left.value;
            const b = right.value;
            if (typeof a === "number" && typeof b === "number") {
              return (a - b) * direction;
            }
            return String(a).localeCompare(String(b)) * direction;
          });

          table.tBodies[0].replaceChildren(
            ...groups.flatMap((group) => (group.detail ? [group.row, group.detail] : [group.row])),
          );
        });
      }
    }
  </script>
</body>
</html>
`;
}
