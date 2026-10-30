import { cloneValue } from './Clone';
import type { ReaderContent, ReaderObject, ReaderProductDocument } from './types';

export const READER_IMAGE_BUCKET = 'ec2_vm.image.special';
function object(value: unknown): ReaderObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ReaderObject : {};
}
function objects(value: unknown): ReaderObject[] { return Array.isArray(value) ? value.map(object) : []; }
function compare(left: string, right: string): number {
  if (left < right) { return -1; }
  if (left > right) { return 1; }
  return 0;
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) { return item; }
    return Object.fromEntries(Object.entries(item).sort(([ a ], [ b ]) => compare(a, b)));
  });
}

/** 仅恢复已经聚合好的 SKU；不执行 dataConfig，不重新过滤、改价或请求外部接口。 */
export function decodePublishedSku(row: ReaderObject): ReaderObject {
  if (row.syntheticImage) { return cloneValue(object(row.attributes)); }
  const product: ReaderObject = {
    resourceType: row.resourceType, cloudServiceType: row.cloudServiceType, resourceSpecCode: row.resourceSpecCode,
    planList: cloneValue(row.planList ?? []), periodList: cloneValue(row.periodList ?? []),
  };
  if (row.locationCode) { product.location_type = row.locationType; product.location_code = row.locationCode; }
  for (const [ key, value ] of Object.entries(object(row.attributes))) { product[key] = cloneValue(value); }
  product._skuInfo = cloneValue(row.skuInfo ?? []);
  return product;
}

/** 独立恢复现网 periodList 索引；免费镜像和 additionProduct 沿用现网协议。 */
export function indexPublishedPeriods<T extends ReaderContent>(content: T): T {
  const copy = cloneValue(content);
  copy.period = {};
  const indexed = new WeakSet<ReaderObject>();
  const indexProduct = (product: ReaderObject, bucket: string) => {
    if (bucket === READER_IMAGE_BUCKET || indexed.has(product)) { return; }
    indexed.add(product);
    if (!Array.isArray(product.periodList)) { throw new TypeError('Processors must return expanded periodList arrays'); }
    const periods = copy.period[bucket] ?? (copy.period[bucket] = []);
    const key = canonical(product.periodList);
    let index = periods.findIndex(item => canonical(item) === key);
    if (index < 0) { index = periods.length; periods.push(product.periodList); }
    product.periodList = index;
    if (product.additionProduct) {
      const child = object(product.additionProduct);
      const bucket = `${String(child.cloudServiceType).replace(/^hws\.service\.type\./, '')}_${String(child.resourceType).replace(/^hws\.resource\.type\./, '')}`;
      indexProduct(child, bucket);
    }
  };
  for (const bucket of Object.keys(copy.product).sort()) {
    copy.period[bucket] ??= [];
    if (bucket === READER_IMAGE_BUCKET) { continue; }
    copy.product[bucket] = [ ...new Map((copy.product[bucket] ?? []).map(product => [ canonical(product), product ])).entries() ]
      .sort(([ a ], [ b ]) => compare(a, b)).map(([ , product ]) => product);
    for (const product of copy.product[bucket] ?? []) { indexProduct(product, bucket); }
  }
  return copy;
}

export function isPublishedCpqPlan(plan: ReaderObject): boolean {
  const divisions = objects(plan.divisionList);
  if (plan.amount === 0) { return false; }
  if (divisions.length) { return divisions.some(item => typeof item.amount === 'number' && item.amount > 0); }
  if (typeof plan.amount === 'number') { return Number.isFinite(plan.amount) && plan.amount !== 0; }
  if (typeof plan.amount === 'string') {
    // joinString/priceInfoChange 的拼接金额仍是合法价格，不能当作免费计划过滤。
    const amounts = plan.amount.split('|').map(Number);
    return amounts.length > 0 && amounts.every(Number.isFinite) && amounts.some(amount => amount !== 0);
  }
  return false;
}
export function publishedCpqBillingMode(plan: ReaderObject): string {
  const mode = String(plan.billingMode ?? '');
  if (mode === 'RI') { return mode; }
  const period = [ 'MONTHLY', 'YEARLY' ].includes(mode) && Number.isInteger(Number(plan.periodNum)) && Number(plan.periodNum) > 0
    ? Number(plan.periodNum) : 1;
  return `${mode}_${period}`;
}
export function publishedListCalcDocument(document: ReaderProductDocument): ReaderObject {
  const rows: ReaderObject[] = [];
  for (const products of Object.values(document.product)) {
    for (const product of products) {
      for (const plan of objects(product.planList).filter(isPublishedCpqPlan)) {
        const row: ReaderObject = { resourceType: product.resourceType, cloudServiceType: product.cloudServiceType, resourceSpecCode: product.resourceSpecCode };
        const description = product.productSpecSysDesc;
        if (description) { row.productSpecSysDesc = typeof description === 'string' ? description.split(';') : description; }
        for (const key of [ 'billingEvent', 'sourceName', 'productId', 'amount', 'siteCode' ]) {
          if (plan[key] !== undefined && plan[key] !== null) { row[key] = String(plan[key]).split('|'); }
        }
        row.billingTime = publishedCpqBillingMode(plan);
        const divisions = objects(plan.divisionList);
        if (divisions.length) { row.division = divisions.map(item => cloneValue(object(item.division))); row.amount = divisions.map(item => item.amount); }
        if (plan.measureUnit !== undefined && plan.measureUnit !== null) { row.tableUnit = ` BSSUNIT.unit.${String(plan.measureUnit)}`; }
        rows.push(row);
      }
    }
  }
  return { ...document, product: rows };
}
