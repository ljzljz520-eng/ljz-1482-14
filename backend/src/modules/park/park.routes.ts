import { Router } from "express";

export const parkRouter = Router();

// 静态站点原有页面所需的只读接口
parkRouter.get("/highlights", (_req, res) => {
  res.json([
    { title: "湖光栈道", desc: "1.6km 环湖漫步，沉浸水雾与灯光艺术。", tag: "夜游首选" },
    { title: "云顶草坡", desc: "18° 坡度草坪，适合露营、飞盘与日落音乐。", tag: "轻野营" },
    { title: "森林书屋", desc: "原木阅读空间，精选自然主题阅读与咖啡。", tag: "静心角" }
  ]);
});

parkRouter.get("/weather", (_req, res) => {
  res.json({ feel: "21°C · 微风", humidity: 63, advise: "11:00 - 15:00 适合亲子漫步。" });
});
