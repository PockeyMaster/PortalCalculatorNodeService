import { Controller } from 'egg';

export default class HomeController extends Controller {
  public async index(): Promise<void> {
    this.ctx.body = { message: 'Welcome to Egg.js', version: '3.x' };
  }

  public async health(): Promise<void> {
    this.ctx.body = { status: 'ok' };
  }
}
