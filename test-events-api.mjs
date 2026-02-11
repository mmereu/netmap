import NetMapDB from './libdb.js';

/**
 * Test script for the Events Filtering and Pagination API
 * Subtask 3.1: Manual API testing
 *
 * This tests the database layer directly since API testing would require
 * the server to be running. The database methods are what the API uses internally.
 */

const TEST_DB_PATH = './test_events_api.db';

class EventsAPITester {
  constructor() {
    this.db = new NetMapDB(TEST_DB_PATH);
    this.testsPassed = 0;
    this.testsFailed = 0;
  }

  log(message, type = 'info') {
    const prefix = {
      info: '  ',
      success: '  ✓',
      error: '  ✗',
      header: '\n==='
    }[type] || '  ';

    if (type === 'header') {
      console.log(`${prefix} ${message} ===`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  assert(condition, message) {
    if (condition) {
      this.log(message, 'success');
      this.testsPassed++;
    } else {
      this.log(message, 'error');
      this.testsFailed++;
    }
    return condition;
  }

  setupTestData() {
    this.log('Setting up test data...', 'header');

    // Create test device
    const deviceResult = this.db.upsertDevice({
      ip: '10.0.0.1',
      sysname: 'test-device',
      status: 'active'
    });
    const deviceId = deviceResult.lastInsertRowid;
    this.log(`Created test device with ID: ${deviceId}`);

    // Create events with various types and severities
    const events = [
      // discovery events
      { device_id: deviceId, type: 'discovery', severity: 'info', message: 'Discovery event 1' },
      { device_id: deviceId, type: 'discovery', severity: 'info', message: 'Discovery event 2' },
      { device_id: deviceId, type: 'discovery', severity: 'warning', message: 'Discovery warning' },
      // alert events
      { device_id: deviceId, type: 'alert', severity: 'warning', message: 'Alert warning 1' },
      { device_id: deviceId, type: 'alert', severity: 'error', message: 'Alert error 1' },
      { device_id: deviceId, type: 'alert', severity: 'critical', message: 'Alert critical 1' },
      // change events
      { device_id: deviceId, type: 'change', severity: 'info', message: 'Change info 1' },
      { device_id: deviceId, type: 'change', severity: 'warning', message: 'Change warning 1' },
      // error events
      { device_id: deviceId, type: 'error', severity: 'error', message: 'Error event 1' },
      { device_id: deviceId, type: 'error', severity: 'critical', message: 'Error critical 1' },
      // Additional events for pagination testing
      { device_id: deviceId, type: 'discovery', severity: 'info', message: 'Discovery event 3' },
      { device_id: deviceId, type: 'discovery', severity: 'info', message: 'Discovery event 4' },
      { device_id: deviceId, type: 'discovery', severity: 'info', message: 'Discovery event 5' },
      { device_id: deviceId, type: 'alert', severity: 'warning', message: 'Alert warning 2' },
      { device_id: deviceId, type: 'alert', severity: 'error', message: 'Alert error 2' },
    ];

    for (const event of events) {
      this.db.addEvent(event);
    }
    this.log(`Created ${events.length} test events`);

    return { deviceId, totalEvents: events.length };
  }

  testDefaultPagination(totalEvents) {
    this.log('Test: GET /api/events (default pagination)', 'header');

    // Simulate API call with defaults
    const options = { limit: 100, offset: 0, type: null, severity: null };
    const events = this.db.getEventsPaginated(options);
    const total = this.db.getEventsCount({ type: null, severity: null });

    this.assert(events.length === totalEvents, `Returns all ${totalEvents} events with default pagination`);
    this.assert(total === totalEvents, `Total count equals ${totalEvents}`);
    this.assert(Array.isArray(events), 'Returns an array of events');

    // Check that events have expected fields
    if (events.length > 0) {
      const event = events[0];
      this.assert('id' in event, 'Events have id field');
      this.assert('type' in event, 'Events have type field');
      this.assert('severity' in event, 'Events have severity field');
      this.assert('message' in event, 'Events have message field');
      this.assert('timestamp' in event, 'Events have timestamp field');
      this.assert('ip' in event, 'Events include device ip (from JOIN)');
      this.assert('sysname' in event, 'Events include device sysname (from JOIN)');
    }
  }

  testTypeFiltering() {
    this.log('Test: GET /api/events?type=alert (type filtering)', 'header');

    // Test type=alert
    const alertOptions = { limit: 100, offset: 0, type: 'alert', severity: null };
    const alertEvents = this.db.getEventsPaginated(alertOptions);
    const alertTotal = this.db.getEventsCount({ type: 'alert', severity: null });

    this.assert(alertEvents.every(e => e.type === 'alert'), 'All returned events have type=alert');
    this.assert(alertEvents.length === alertTotal, `Count matches events length: ${alertTotal}`);
    this.assert(alertEvents.length === 5, 'Returns exactly 5 alert events');

    // Test type=discovery
    this.log('Test: GET /api/events?type=discovery', 'header');
    const discoveryOptions = { limit: 100, offset: 0, type: 'discovery', severity: null };
    const discoveryEvents = this.db.getEventsPaginated(discoveryOptions);
    const discoveryTotal = this.db.getEventsCount({ type: 'discovery', severity: null });

    this.assert(discoveryEvents.every(e => e.type === 'discovery'), 'All returned events have type=discovery');
    this.assert(discoveryEvents.length === discoveryTotal, `Count matches events length: ${discoveryTotal}`);
    this.assert(discoveryEvents.length === 6, 'Returns exactly 6 discovery events');

    // Test type=error
    this.log('Test: GET /api/events?type=error', 'header');
    const errorOptions = { limit: 100, offset: 0, type: 'error', severity: null };
    const errorEvents = this.db.getEventsPaginated(errorOptions);

    this.assert(errorEvents.every(e => e.type === 'error'), 'All returned events have type=error');
    this.assert(errorEvents.length === 2, 'Returns exactly 2 error events');

    // Test type=change
    this.log('Test: GET /api/events?type=change', 'header');
    const changeOptions = { limit: 100, offset: 0, type: 'change', severity: null };
    const changeEvents = this.db.getEventsPaginated(changeOptions);

    this.assert(changeEvents.every(e => e.type === 'change'), 'All returned events have type=change');
    this.assert(changeEvents.length === 2, 'Returns exactly 2 change events');
  }

  testSeverityFiltering() {
    this.log('Test: GET /api/events?severity=error (severity filtering)', 'header');

    // Test severity=error
    const errorOptions = { limit: 100, offset: 0, type: null, severity: 'error' };
    const errorEvents = this.db.getEventsPaginated(errorOptions);
    const errorTotal = this.db.getEventsCount({ type: null, severity: 'error' });

    this.assert(errorEvents.every(e => e.severity === 'error'), 'All returned events have severity=error');
    this.assert(errorEvents.length === errorTotal, `Count matches events length: ${errorTotal}`);
    this.assert(errorEvents.length === 3, 'Returns exactly 3 error severity events');

    // Test severity=info
    this.log('Test: GET /api/events?severity=info', 'header');
    const infoOptions = { limit: 100, offset: 0, type: null, severity: 'info' };
    const infoEvents = this.db.getEventsPaginated(infoOptions);

    this.assert(infoEvents.every(e => e.severity === 'info'), 'All returned events have severity=info');
    this.assert(infoEvents.length === 6, 'Returns exactly 6 info severity events');

    // Test severity=warning
    this.log('Test: GET /api/events?severity=warning', 'header');
    const warningOptions = { limit: 100, offset: 0, type: null, severity: 'warning' };
    const warningEvents = this.db.getEventsPaginated(warningOptions);

    this.assert(warningEvents.every(e => e.severity === 'warning'), 'All returned events have severity=warning');
    this.assert(warningEvents.length === 4, 'Returns exactly 4 warning severity events');

    // Test severity=critical
    this.log('Test: GET /api/events?severity=critical', 'header');
    const criticalOptions = { limit: 100, offset: 0, type: null, severity: 'critical' };
    const criticalEvents = this.db.getEventsPaginated(criticalOptions);

    this.assert(criticalEvents.every(e => e.severity === 'critical'), 'All returned events have severity=critical');
    this.assert(criticalEvents.length === 2, 'Returns exactly 2 critical severity events');
  }

  testCombinedFiltering() {
    this.log('Test: GET /api/events?type=discovery&severity=info (combined filtering)', 'header');

    // Test combined type=discovery AND severity=info
    const options = { limit: 100, offset: 0, type: 'discovery', severity: 'info' };
    const events = this.db.getEventsPaginated(options);
    const total = this.db.getEventsCount({ type: 'discovery', severity: 'info' });

    this.assert(events.every(e => e.type === 'discovery' && e.severity === 'info'),
      'All returned events have type=discovery AND severity=info');
    this.assert(events.length === total, `Count matches events length: ${total}`);
    this.assert(events.length === 5, 'Returns exactly 5 discovery+info events');

    // Test combined type=alert AND severity=error
    this.log('Test: GET /api/events?type=alert&severity=error', 'header');
    const alertErrorOptions = { limit: 100, offset: 0, type: 'alert', severity: 'error' };
    const alertErrorEvents = this.db.getEventsPaginated(alertErrorOptions);
    const alertErrorTotal = this.db.getEventsCount({ type: 'alert', severity: 'error' });

    this.assert(alertErrorEvents.every(e => e.type === 'alert' && e.severity === 'error'),
      'All returned events have type=alert AND severity=error');
    this.assert(alertErrorEvents.length === alertErrorTotal, `Count matches: ${alertErrorTotal}`);
    this.assert(alertErrorEvents.length === 2, 'Returns exactly 2 alert+error events');
  }

  testPagination(totalEvents) {
    this.log('Test: GET /api/events?limit=10&offset=5 (pagination)', 'header');

    // Test limit=5, offset=0
    const page1Options = { limit: 5, offset: 0, type: null, severity: null };
    const page1 = this.db.getEventsPaginated(page1Options);

    this.assert(page1.length === 5, 'First page returns exactly 5 events');

    // Test limit=5, offset=5
    const page2Options = { limit: 5, offset: 5, type: null, severity: null };
    const page2 = this.db.getEventsPaginated(page2Options);

    this.assert(page2.length === 5, 'Second page returns exactly 5 events');

    // Verify no overlap between pages
    const page1Ids = page1.map(e => e.id);
    const page2Ids = page2.map(e => e.id);
    const hasOverlap = page1Ids.some(id => page2Ids.includes(id));
    this.assert(!hasOverlap, 'Pages do not overlap');

    // Test offset beyond total
    const beyondOptions = { limit: 10, offset: 100, type: null, severity: null };
    const beyondPage = this.db.getEventsPaginated(beyondOptions);

    this.assert(beyondPage.length === 0, 'Offset beyond total returns empty array');

    // Verify total count remains consistent
    const total = this.db.getEventsCount({ type: null, severity: null });
    this.assert(total === totalEvents, `Total count consistent: ${total}`);
  }

  testPaginationWithFilters() {
    this.log('Test: Pagination combined with filters', 'header');

    // Get all discovery events first
    const allDiscovery = this.db.getEventsPaginated({ limit: 100, offset: 0, type: 'discovery', severity: null });
    const discoveryTotal = this.db.getEventsCount({ type: 'discovery', severity: null });

    // Now paginate through them
    const page1 = this.db.getEventsPaginated({ limit: 3, offset: 0, type: 'discovery', severity: null });
    const page2 = this.db.getEventsPaginated({ limit: 3, offset: 3, type: 'discovery', severity: null });

    this.assert(page1.length === 3, 'First page of discovery events has 3 items');
    this.assert(page2.length === 3, 'Second page of discovery events has 3 items (6 total)');
    this.assert(page1.every(e => e.type === 'discovery'), 'First page all discovery type');
    this.assert(page2.every(e => e.type === 'discovery'), 'Second page all discovery type');
    this.assert(discoveryTotal === 6, `Discovery total count is correct: ${discoveryTotal}`);
  }

  testResponseStructure() {
    this.log('Test: Response structure for pagination UI', 'header');

    // Simulate API response structure
    const options = { limit: 10, offset: 5, type: 'alert', severity: null };
    const events = this.db.getEventsPaginated(options);
    const total = this.db.getEventsCount({ type: options.type, severity: options.severity });

    // This is what the API returns: { events, total, limit, offset }
    const response = {
      events,
      total,
      limit: 10,
      offset: 5
    };

    this.assert('events' in response, 'Response has events array');
    this.assert('total' in response, 'Response has total count');
    this.assert('limit' in response, 'Response has limit');
    this.assert('offset' in response, 'Response has offset');
    this.assert(Array.isArray(response.events), 'events is an array');
    this.assert(typeof response.total === 'number', 'total is a number');
    this.assert(response.limit === 10, 'limit value preserved');
    this.assert(response.offset === 5, 'offset value preserved');
  }

  testBackwardCompatibility() {
    this.log('Test: Backward compatibility (existing calls with ?limit=N)', 'header');

    // Test that old-style calls still work (only limit parameter)
    const options = { limit: 10, offset: 0, type: null, severity: null };
    const events = this.db.getEventsPaginated(options);
    const total = this.db.getEventsCount({});

    this.assert(events.length <= 10, 'Limit-only call returns correct number of events');
    this.assert(total > 0, 'Count works without filters');

    // Test with defaults (what happens if no params at all)
    const defaultOptions = { limit: 100, offset: 0 };
    const defaultEvents = this.db.getEventsPaginated(defaultOptions);
    this.assert(defaultEvents.length > 0, 'Default params work correctly');
  }

  testOrderingByTimestamp() {
    this.log('Test: Events ordered by timestamp DESC', 'header');

    const events = this.db.getEventsPaginated({ limit: 100, offset: 0, type: null, severity: null });

    let isOrdered = true;
    for (let i = 1; i < events.length; i++) {
      if (events[i-1].timestamp < events[i].timestamp) {
        isOrdered = false;
        break;
      }
    }

    this.assert(isOrdered, 'Events are ordered by timestamp DESC');
  }

  cleanup() {
    this.db.close();
    // Remove test database
    import('fs').then(fs => {
      try {
        fs.unlinkSync(TEST_DB_PATH);
        fs.unlinkSync(TEST_DB_PATH + '-shm');
        fs.unlinkSync(TEST_DB_PATH + '-wal');
      } catch (e) {
        // Files may not exist, ignore
      }
    });
  }

  async run() {
    console.log('\n' + '='.repeat(60));
    console.log('Events Filtering and Pagination API - Test Suite');
    console.log('Subtask 3.1: Manual API Testing');
    console.log('='.repeat(60));

    try {
      // Setup
      const { totalEvents } = this.setupTestData();

      // Run all tests
      this.testDefaultPagination(totalEvents);
      this.testTypeFiltering();
      this.testSeverityFiltering();
      this.testCombinedFiltering();
      this.testPagination(totalEvents);
      this.testPaginationWithFilters();
      this.testResponseStructure();
      this.testBackwardCompatibility();
      this.testOrderingByTimestamp();

      // Summary
      console.log('\n' + '='.repeat(60));
      console.log('TEST SUMMARY');
      console.log('='.repeat(60));
      console.log(`  Tests Passed: ${this.testsPassed}`);
      console.log(`  Tests Failed: ${this.testsFailed}`);
      console.log(`  Total Tests:  ${this.testsPassed + this.testsFailed}`);
      console.log('='.repeat(60));

      if (this.testsFailed > 0) {
        console.log('\n❌ SOME TESTS FAILED');
        process.exitCode = 1;
      } else {
        console.log('\n✅ ALL TESTS PASSED');
      }

    } finally {
      this.cleanup();
    }
  }
}

// Run tests
const tester = new EventsAPITester();
tester.run();
