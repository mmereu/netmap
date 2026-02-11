/**
 * Test suite for middleware/errorHandler.js
 */
import {
  AppError,
  Errors,
  asyncHandler,
  errorHandler,
  validate,
  requireFields
} from './middleware/errorHandler.js';

let passed = 0;
let failed = 0;

function test(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

console.log('\n=== Error Handler Test Suite ===\n');

// AppError tests
console.log('AppError:');
const err1 = new AppError('Test error', 400, 'TEST_CODE', { foo: 'bar' });
test('has correct message', err1.message === 'Test error');
test('has correct statusCode', err1.statusCode === 400);
test('has correct code', err1.code === 'TEST_CODE');
test('has correct details', err1.details?.foo === 'bar');
test('isOperational is true', err1.isOperational === true);
test('has stack trace', err1.stack !== undefined);

const json = err1.toJSON();
test('toJSON has success false', json.success === false);
test('toJSON has error.code', json.error.code === 'TEST_CODE');
test('toJSON has error.message', json.error.message === 'Test error');
test('toJSON has error.details', json.error.details?.foo === 'bar');

// Errors factory tests
console.log('\nErrors factories:');
test('badRequest', Errors.badRequest('test').statusCode === 400);
test('unauthorized', Errors.unauthorized().statusCode === 401);
test('forbidden', Errors.forbidden().statusCode === 403);
test('notFound', Errors.notFound('User').statusCode === 404);
test('notFound message', Errors.notFound('User').message === 'User non trovato');
test('conflict', Errors.conflict('test').statusCode === 409);
test('validation', Errors.validation('test').statusCode === 422);
test('internal', Errors.internal().statusCode === 500);
test('serviceUnavailable', Errors.serviceUnavailable().statusCode === 503);
test('timeout', Errors.timeout().statusCode === 504);

// asyncHandler tests
console.log('\nasyncHandler:');
let nextCalled = false;
let nextError = null;
const mockNext = (err) => { nextCalled = true; nextError = err; };

// Test with successful async function
nextCalled = false;
nextError = null;
const successHandler = asyncHandler(async (req, res) => {
  return 'success';
});
await successHandler({}, {}, mockNext);
test('success - next not called with error', nextError === undefined || nextError === null);

// Test with failing async function
nextCalled = false;
nextError = null;
const failHandler = asyncHandler(async (req, res) => {
  throw new Error('Test failure');
});
await failHandler({}, {}, mockNext);
test('failure - next called', nextCalled === true);
test('failure - next called with error', nextError?.message === 'Test failure');

// validate tests
console.log('\nvalidate:');
test('validate passes on true', (() => { validate(true, 'should not throw'); return true; })());

let validateThrew = false;
try {
  validate(false, 'should throw');
} catch (e) {
  validateThrew = e instanceof AppError && e.code === 'VALIDATION_ERROR';
}
test('validate throws on false', validateThrew);

// requireFields tests
console.log('\nrequireFields:');
test('requireFields passes with all fields', (() => {
  requireFields({ a: 1, b: 2 }, ['a', 'b']);
  return true;
})());

let requireThrew = false;
let missingFields = null;
try {
  requireFields({ a: 1 }, ['a', 'b', 'c']);
} catch (e) {
  requireThrew = e instanceof AppError && e.code === 'BAD_REQUEST';
  missingFields = e.details?.missing;
}
test('requireFields throws on missing', requireThrew);
test('requireFields reports missing fields', missingFields?.includes('b') && missingFields?.includes('c'));

// errorHandler tests
console.log('\nerrorHandler:');
let responseStatus = null;
let responseJson = null;
const mockRes = {
  status: (code) => { responseStatus = code; return mockRes; },
  json: (data) => { responseJson = data; return mockRes; }
};
const mockReq = { method: 'GET', originalUrl: '/test' };

// Test with AppError
responseStatus = null;
responseJson = null;
errorHandler(Errors.notFound('Device'), mockReq, mockRes, () => {});
test('AppError - correct status', responseStatus === 404);
test('AppError - success false', responseJson?.success === false);
test('AppError - has error code', responseJson?.error?.code === 'NOT_FOUND');

// Test with regular Error
responseStatus = null;
responseJson = null;
errorHandler(new Error('regular error'), mockReq, mockRes, () => {});
test('Regular Error - status 500', responseStatus === 500);
test('Regular Error - generic message', responseJson?.error?.message === 'Errore interno del server');

// Summary
console.log('\n=== Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
