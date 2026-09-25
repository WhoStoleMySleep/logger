import * as api from '../index';

describe('package entry point', () => {
  it('should re-export the public API', () => {
    expect(typeof api.createLogger).toBe('function');
    expect(typeof api.Logger).toBe('function');
    expect(api.LogLevel.INFO).toBe('info');
  });
});
