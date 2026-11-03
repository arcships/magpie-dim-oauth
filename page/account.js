const $ = (id) => document.getElementById(id);
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
const session = document.querySelector('meta[name="dim-session"]').content;
let account = "";
let view;
let confirmation;
let applying = false;
let busy = false;
let revision = 0;
const format = (value) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
const date = (value) => new Date(value).toLocaleString("zh-CN");

async function api(path, body = {}) {
  const response = await fetch(new URL(path, location.href), {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dim-Session": session },
    body: JSON.stringify({ account, ...body }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function buttons() {
  document.querySelectorAll("[data-reset]").forEach((button) => {
    button.disabled = busy || !view?.subscriptionId || !view.resets[button.dataset.reset].available;
  });
  $("refresh").disabled = busy;
  $("account").disabled = busy;
}

function render() {
  $("content").hidden = !view;
  if (!view) return;
  $("plan-name").textContent = view.plan?.name || "尚未订阅";
  const expired = view.plan?.end && Date.parse(view.plan.end) <= Date.now();
  $("plan-status").textContent = expired ? "已到期" : ({ active: "使用中", expired: "已到期", cancelled: "已取消", canceled: "已取消", pending: "待支付" })[view.plan?.status] || view.plan?.status || "无套餐";
  const details = [];
  if (view.plan?.amount !== undefined) details.push(`${format(view.plan.amount)} ${view.plan.currency || ""} / ${({ month: "月", year: "年", week: "周", day: "日" })[view.plan.interval] || view.plan.interval || "期"}`);
  if (view.plan?.end) details.push(`到期时间 ${date(view.plan.end)}`);
  if (view.plan?.cancelAtPeriodEnd) details.push("本期结束后取消");
  $("plan-meta").textContent = details.join(" · ");
  $("purchase-url").value = view.subscriptionUrl;
  $("pricing-url").value = view.pricingUrl;
  $("windows").replaceChildren();
  for (const window of view.windows) {
    const row = document.createElement("div"); row.className = "meter";
    const heading = document.createElement("div"); heading.className = "meter-heading";
    const name = document.createElement("strong");
    name.textContent = ({ Subscription: "月度额度", Credits: "可用额度", Usage: "套餐额度", web_search: "联网搜索" })[window.name] || window.name.replace("h window", " 小时窗口");
    const amount = document.createElement("span");
    amount.textContent = window.limit !== undefined ? `${format(window.amount)} / ${format(window.limit)} ${window.unit || ""}` : window.display === "Unlimited" ? "不限额度" : window.display;
    heading.append(name, amount); row.append(heading);
    if (window.used !== undefined) { const progress = document.createElement("progress"); progress.max = 100; progress.value = Math.min(100, window.used); progress.setAttribute("aria-label", `${name.textContent} 已用 ${format(window.used)}%`); row.append(progress); }
    if (window.resetsAt) { const reset = document.createElement("p"); reset.className = "muted"; reset.dataset.resetAt = window.resetsAt; row.append(reset); }
    $("windows").append(row);
  }
  for (const [kind, id] of [["window", "window-count"], ["monthly_full", "monthly-count"]]) {
    const reset = view.resets[kind];
    $(id).textContent = `剩余 ${reset.available} 次${reset.expiresAt ? `，最近到期 ${date(reset.expiresAt)}` : ""}`;
  }
  countdowns(); buttons();
}

function countdowns() {
  document.querySelectorAll("[data-reset-at]").forEach((node) => {
    const remaining = Date.parse(node.dataset.resetAt) - Date.now();
    const minutes = Math.max(0, Math.ceil(remaining / 60_000));
    node.textContent = remaining <= 0 ? `重置时间已到，请刷新用量（${date(node.dataset.resetAt)}）` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后重置 · ${date(node.dataset.resetAt)}`;
  });
}

async function load() {
  const current = ++revision;
  busy = true; buttons(); $("message").textContent = ""; $("message").dataset.kind = "error";
  try {
    const result = await api("accounts");
    if (current !== revision) return;
    if (!result.accounts.some((item) => item.id === account)) account = result.accounts[0]?.id || "";
    $("account").replaceChildren(...result.accounts.map((item) => { const option = document.createElement("option"); option.value = item.id; option.textContent = item.label; return option; }));
    $("account").value = account;
    $("empty").hidden = Boolean(account);
    if (!account) { view = undefined; $("content").hidden = true; return; }
    const next = await api("view");
    if (current === revision) { view = next; render(); }
  } catch (error) { if (current === revision) $("message").textContent = error.message; }
  finally { if (current === revision) { busy = false; buttons(); } }
}

$("refresh").onclick = load;
$("account").onchange = () => { account = $("account").value; view = undefined; $("content").hidden = true; load(); };
for (const id of ["purchase", "renew", "pricing"]) $(id).onclick = async () => {
  try { await api("open", { page: id === "pricing" ? "pricing" : "subscription" }); }
  catch (error) { $("message").textContent = error.message; }
};
document.querySelectorAll("[data-reset]").forEach((button) => button.onclick = async () => {
  busy = true; buttons(); $("message").textContent = "";
  try {
    confirmation = await api("reset/prepare", { kind: button.dataset.reset });
    $("confirm-title").textContent = confirmation.kind === "window" ? "确认重置用量窗口" : "确认恢复月度额度";
    $("confirm-summary").textContent = `${confirmation.user} 的 ${confirmation.plan || "当前套餐"}（#${confirmation.subscriptionId}）将消耗 1 次重置次数。当前剩余 ${confirmation.available} 次。`;
    $("batches").replaceChildren(...(confirmation.batches || []).map((batch) => { const li = document.createElement("li"); li.textContent = `${batch.count} 次，${date(batch.expiresAt)} 到期（${({ admin_compensation: "运营补偿", campaign: "活动发放", incident_compensation: "故障补偿" })[batch.source] || batch.source}）`; return li; }));
    $("confirm-notice").textContent = confirmation.detailsUnavailable ? "重置批次明细暂时不可用。是否可用以服务端结果为准。" : "优先消费最早到期的适用次数。";
    $("confirm-error").textContent = "";
    $("confirmation").showModal();
  } catch (error) { $("message").textContent = error.message; busy = false; buttons(); }
});
$("cancel").onclick = () => { if (!applying) $("confirmation").close(); };
$("confirmation").addEventListener("cancel", (event) => { if (applying) event.preventDefault(); });
$("confirmation").addEventListener("close", () => { confirmation = undefined; busy = false; buttons(); });
$("apply").onclick = async () => {
  if (!confirmation || applying) return;
  applying = true; $("apply").disabled = true; $("cancel").disabled = true; $("confirm-error").textContent = "";
  try {
    const result = await api("reset/apply", { confirmation: confirmation.confirmation });
    view = result.view; render(); $("confirmation").close();
    $("message").dataset.kind = "success";
    $("message").textContent = result.replayed ? "这次重置已处理，未重复消耗次数。" : "重置成功，用量已更新。";
  } catch (error) { $("confirm-error").textContent = `${error.message}。如需重试，请继续使用此确认窗口，避免重复操作。`; }
  finally { applying = false; $("apply").disabled = false; $("cancel").disabled = false; }
};
setInterval(countdowns, 30_000);
load();
