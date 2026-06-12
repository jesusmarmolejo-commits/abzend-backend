// Construye un query builder encadenable (select/eq/order/...) que además
// es awaitable directamente (para queries sin .single()) y soporta .single()
function buildResult(result) {
  const builder = {};
  ['select', 'eq', 'order', 'in', 'update', 'insert'].forEach((method) => {
    builder[method] = jest.fn(() => builder);
  });
  builder.single = jest.fn(() => Promise.resolve(result));
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  builder.catch = (reject) => Promise.resolve(result).catch(reject);
  return builder;
}

const mockFrom = jest.fn();

jest.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: mockFrom },
  supabase: {},
}));

const { getEvidence } = require('../evidenceController.js');

const ORDER_ID = 'order-123';

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function setupOrders(order) {
  mockFrom.mockImplementation((table) => {
    if (table === 'orders') {
      return buildResult({ data: order, error: order ? null : { message: 'not found' } });
    }
    if (table === 'delivery_evidence') {
      return buildResult({ data: [{ id: 'ev-1', order_id: ORDER_ID, evidence_type: 'photo' }], error: null });
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

describe('getEvidence — IDOR fix (CRIT-04)', () => {
  beforeEach(() => {
    mockFrom.mockReset();
  });

  test('cliente A pidiendo orden de cliente B recibe 404', async () => {
    setupOrders({ id: ORDER_ID, client_id: 'client-B', driver_id: null });

    const req = { params: { id: ORDER_ID }, user: { id: 'client-A', role: 'client' } };
    const res = mockRes();

    await getEvidence(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Orden no encontrada' });
  });

  test('cliente A pidiendo su propia orden recibe 200', async () => {
    setupOrders({ id: ORDER_ID, client_id: 'client-A', driver_id: null });

    const req = { params: { id: ORDER_ID }, user: { id: 'client-A', role: 'client' } };
    const res = mockRes();

    await getEvidence(req, res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      evidence: [{ id: 'ev-1', order_id: ORDER_ID, evidence_type: 'photo' }],
      count: 1,
    });
  });

  test('admin pidiendo cualquier orden recibe 200', async () => {
    setupOrders({ id: ORDER_ID, client_id: 'client-B', driver_id: null });

    const req = { params: { id: ORDER_ID }, user: { id: 'admin-1', role: 'admin' } };
    const res = mockRes();

    await getEvidence(req, res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      evidence: [{ id: 'ev-1', order_id: ORDER_ID, evidence_type: 'photo' }],
      count: 1,
    });
  });
});
