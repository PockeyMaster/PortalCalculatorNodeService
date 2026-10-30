import type { Application } from 'egg';

export default (app: Application): void => {
  app.router.get('/', app.controller.home.index);
  app.router.get('/health', app.controller.home.health);
  // 根路由便于模拟；完整路径沿用用户侧现网接口协议。站点/通道只能由部署配置选择。
  for (const prefix of [ '', '/rest/cbc/portalcalculatornodeservice/v4/api' ]) {
    app.router.get(`${prefix}/config`, app.controller.calculator.getConfig);
    app.router.get(`${prefix}/productInfo`, app.controller.calculator.productInfo);
    app.router.get(`${prefix}/menuInfo`, app.controller.calculator.menuInfo);
    app.router.get(`${prefix}/language`, app.controller.calculator.language);
  }
};
