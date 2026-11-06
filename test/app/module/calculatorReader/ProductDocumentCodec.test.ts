import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cloneValue } from '../../../../app/module/calculatorReader/Clone';
import { decodePublishedSku, indexPublishedPeriods, indexPublishedPeriodsInPlace,
  publishedListCalcDocument, READER_IMAGE_BUCKET } from '../../../../app/module/calculatorReader/ProductDocumentCodec';
import type { ReaderContent, ReaderObject, ReaderProductDocument } from '../../../../app/module/calculatorReader/types';

// 在优化前用原实现生成，保留 JSON 字段顺序以检查序列化内容是否完全一致。
const baseline = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/product-period-baseline.json'), 'utf8')) as {
  input: ReaderContent; expected: ReaderContent; expectedListCalc: ReaderObject;
};

describe('published product period ownership and compatibility', () => {
  it('keeps calc/detail JSON byte-for-byte identical to the pre-optimization output', () => {
    for (const tab of [ 'calc', 'detail' ] as const) {
      const input = cloneValue(baseline.input);
      const dimensions = { urlPath: 'ecs', tag: 'general.online.portal', region: 'test-region', tab };
      const result = { ...indexPublishedPeriodsInPlace(input), ...dimensions };
      assert.equal(JSON.stringify(result), JSON.stringify({ ...baseline.expected, ...dimensions }));
    }
  });

  it('keeps listCalc prices, RI, joined prices and tiered billing identical', () => {
    const indexed = indexPublishedPeriodsInPlace(cloneValue(baseline.input));
    const document: ReaderProductDocument = { ...indexed, urlPath: 'ecs', tag: 'general.online.portal',
      region: 'test-region', tab: 'listCalc' };
    assert.equal(JSON.stringify(publishedListCalcDocument(document)), JSON.stringify(baseline.expectedListCalc));
  });

  it('indexes owned products in place without cloning plans, images or SKU attributes again', () => {
    const input = cloneValue(baseline.input);
    const product = input.product.ec2_vm[1];
    const plans = product.planList;
    const skuInfo = product._skuInfo;
    const periods = product.periodList;
    const images = input.product[READER_IMAGE_BUCKET];
    assert.strictEqual(indexPublishedPeriodsInPlace(input), input);
    assert.ok(input.product.ec2_vm.includes(product));
    assert.strictEqual(product.planList, plans);
    assert.strictEqual(product._skuInfo, skuInfo);
    assert.strictEqual(input.period.ec2_vm[product.periodList as number], periods);
    assert.strictEqual(input.product[READER_IMAGE_BUCKET], images);
    assert.deepEqual(input.product[READER_IMAGE_BUCKET], baseline.input.product[READER_IMAGE_BUCKET]);
  });

  it('preserves the existing non-mutating helper contract', () => {
    const input = cloneValue(baseline.input);
    const before = JSON.stringify(input);
    const result = indexPublishedPeriods(input);
    assert.equal(JSON.stringify(input), before);
    assert.equal(JSON.stringify(result), JSON.stringify(baseline.expected));
    assert.notStrictEqual(result.product.ec2_vm[0].planList, input.product.ec2_vm[0].planList);
    assert.notStrictEqual(result.product[READER_IMAGE_BUCKET], input.product[READER_IMAGE_BUCKET]);
  });

  it('indexes shared additionProduct objects only once and preserves duplicate elimination', () => {
    const child = { resourceType: 'hws.resource.type.volume', cloudServiceType: 'hws.service.type.ebs',
      periodList: [{ periodType: 'MONTH' }], planList: [] };
    const parent = { resourceSpecCode: 'parent', periodList: [], additionProduct: child };
    const input: ReaderContent = { product: { a_parent: [ parent, parent ], ebs_volume: [ child ] }, period: {} };
    const expected = indexPublishedPeriods(input);
    assert.equal(JSON.stringify(indexPublishedPeriodsInPlace(input)), JSON.stringify(expected));
    assert.equal(input.product.a_parent.length, 1);
    assert.strictEqual(input.product.a_parent[0].additionProduct, input.product.ebs_volume[0]);
    assert.equal(child.periodList, 0);
    assert.equal(input.period.ebs_volume.length, 1);
  });

  it('keeps Mongo snapshot plans, nested children and free images isolated from in-place changes', () => {
    const source: ReaderObject = { resourceType: 'vm', cloudServiceType: 'ec2', resourceSpecCode: 'spec',
      planList: [{ amount: 2, divisionList: [{ amount: 1 }] }], periodList: [{ periodType: 'MONTH' }],
      attributes: { additionProduct: { cloudServiceType: 'hws.service.type.ebs', resourceType: 'hws.resource.type.volume',
        periodList: [], planList: [{ amount: 1 }] } }, skuInfo: [ 'CPU:2' ] };
    const imageRow: ReaderObject = { syntheticImage: true, attributes: { id: 'image', metadata: { os: 'Linux' } } };
    const before = JSON.stringify({ source, imageRow });
    const decoded = decodePublishedSku(source);
    const image = decodePublishedSku(imageRow);
    indexPublishedPeriodsInPlace({ product: { ec2_vm: [ decoded ], [READER_IMAGE_BUCKET]: [ image ] }, period: {} });
    (decoded.planList as ReaderObject[])[0].amount = 99;
    (decoded._skuInfo as string[]).push('memory:4');
    (image.metadata as ReaderObject).os = 'Windows';
    assert.equal(JSON.stringify({ source, imageRow }), before);
  });
});
