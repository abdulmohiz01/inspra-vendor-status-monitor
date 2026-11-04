export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#1a7f37"/></svg>';

export const APP_CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: #f6f8fa; color: #1f2328; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
header, main, footer { max-width: 1100px; margin: 0 auto; padding: 16px 20px; }
header h1 { margin: 0 0 4px; font-size: 24px; }
.overall { font-weight: 600; }
.overall.ok { color: #1a7f37; }
.overall.bad { color: #cf222e; }
.muted { color: #59636e; font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.card { background: #fff; border: 1px solid #d1d9e0; border-radius: 8px; padding: 14px; }
.card:target { outline: 2px solid #0969da; }
.card h2 { margin: 0 0 6px; font-size: 17px; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.badge { color: #fff; border-radius: 999px; padding: 1px 10px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.card p { margin: 4px 0; }
.tag { display: inline-block; border: 1px solid #d1d9e0; border-radius: 4px; padding: 0 6px; font-size: 12px; color: #59636e; }
.error { color: #cf222e; word-break: break-word; }
.strip { display: flex; gap: 3px; margin-top: 10px; }
.strip span { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }
footer { border-top: 1px solid #d1d9e0; margin-top: 16px; }
`;
