import type { Application } from 'egg';
import { CalculatorReaderRuntime } from './app/module/calculatorReader';

/** 只创建延迟连接客户端；启动和存活探针不访问 Redis/Mongo。 */
export default class AppBootHook {
  constructor(private readonly app: Application) {}

  async didLoad(): Promise<void> {
    const { calculatorReader } = this.app.config;
    this.app.calculatorReaderRuntime = new CalculatorReaderRuntime(calculatorReader.settings, calculatorReader.connections, this.app.logger);
  }

  async didReady(): Promise<void> {
    this.app.calculatorReaderRuntime.startRefresh();
  }

  async beforeClose(): Promise<void> {
    await this.app.calculatorReaderRuntime?.close();
  }
}
