import type { CalculatorReaderRuntime, CalculatorReaderConfig, CalculatorReaderConnections } from '../app/module/calculatorReader';
import type CalculatorController from '../app/controller/calculator';

declare module 'egg' {
  interface Application { calculatorReaderRuntime: CalculatorReaderRuntime }
  interface EggAppConfig {
    calculatorReader: { settings: CalculatorReaderConfig; connections: CalculatorReaderConnections };
  }
  interface IController { calculator: CalculatorController }
}
