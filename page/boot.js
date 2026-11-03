(async () => {
  try {
    const theme = await magpie.ready;
    const options = await magpie.options.get();
    const target = new URL(magpie.service || `http://127.0.0.1:${options.port ?? 3488}/`);
    target.searchParams.set("theme", theme.dark ? "dark" : "light");
    location.replace(target.href);
  } catch {
    document.getElementById("status").textContent = "账户页面未能启动，请在 Magpie 中重新启用插件。";
  }
})();
