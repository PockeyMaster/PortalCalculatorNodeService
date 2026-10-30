import { Controller } from 'egg';
import { CalculatorDataUnavailableError, CalculatorInputError, CalculatorNotFoundError } from '../module/calculatorReader';

/** 四个只读消费接口；站点/channel 由部署配置决定，不能用请求切换到其他站点。 */
export default class CalculatorController extends Controller {
  async getConfig(): Promise<void> {
    await this.respond(async () => this.app.calculatorReaderRuntime.service.configDocument(this.ctx.query), true);
  }
  async productInfo(): Promise<void> {
    await this.respond(async () => this.app.calculatorReaderRuntime.service.productInfo(this.ctx.query));
  }
  async menuInfo(): Promise<void> {
    await this.respond(async () => this.app.calculatorReaderRuntime.service.menuInfo(this.ctx.query));
  }
  async language(): Promise<void> {
    await this.respond(async () => this.app.calculatorReaderRuntime.service.language(this.ctx.query));
  }
  private async respond(read: () => Promise<unknown>, javascript = false): Promise<void> {
    try {
      const body = await read();
      this.ctx.type = javascript ? 'application/javascript' : 'application/json';
      this.ctx.status = 200;
      this.ctx.body = body;
    } catch (error) {
      if (error instanceof CalculatorInputError) { this.ctx.throw(400, error.message); }
      if (error instanceof CalculatorNotFoundError) { this.ctx.throw(404, error.message); }
      if (error instanceof CalculatorDataUnavailableError) { this.ctx.throw(503, error.message); }
      throw error;
    }
  }
}
