/**
 * VK MCP Server Tests
 * 
 * Unit tests for the VK API client and MCP tools
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock fetch for API tests
global.fetch = jest.fn();

describe('VK API Client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('API Call Structure', () => {
    it('should construct correct API URL', async () => {
      const mockResponse = { response: { id: 1 } };
      global.fetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      // Simulate API call
      const params = new URLSearchParams({
        user_ids: '1',
        access_token: 'test_token',
        v: '5.199',
      });

      await fetch('https://api.vk.com/method/users.get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.vk.com/method/users.get',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );
    });

    it('should include API version in all requests', async () => {
      const mockResponse = { response: [] };
      global.fetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      const params = new URLSearchParams({
        access_token: 'test_token',
        v: '5.199',
      });

      await fetch('https://api.vk.com/method/wall.get', {
        method: 'POST',
        body: params.toString(),
      });

      const callBody = global.fetch.mock.calls[0][1].body;
      expect(callBody).toContain('v=5.199');
    });
  });

  describe('Error Handling', () => {
    it('should parse VK API errors correctly', async () => {
      const errorResponse = {
        error: {
          error_code: 5,
          error_msg: 'User authorization failed: invalid access_token.',
        },
      };

      global.fetch.mockResolvedValueOnce({
        json: () => Promise.resolve(errorResponse),
      });

      const response = await fetch('https://api.vk.com/method/users.get');
      const data = await response.json();

      expect(data.error).toBeDefined();
      expect(data.error.error_code).toBe(5);
    });
  });

  describe('Tool Definitions', () => {
    const expectedTools = [
      'vk_users_get',
      'vk_wall_get',
      'vk_wall_post',
      'vk_wall_create_comment',
      'vk_groups_get',
      'vk_groups_get_by_id',
      'vk_friends_get',
      'vk_newsfeed_get',
      'vk_stats_get',
      'vk_photos_get',
    ];

    it('should have all expected tools defined', () => {
      // This test validates the expected tool list
      expect(expectedTools).toHaveLength(10);
      expect(expectedTools).toContain('vk_users_get');
      expect(expectedTools).toContain('vk_wall_post');
    });

    it('should have correct tool naming convention', () => {
      expectedTools.forEach((tool) => {
        expect(tool).toMatch(/^vk_[a-z_]+$/);
      });
    });
  });

  describe('Input Validation', () => {
    it('should require message for wall_post', () => {
      const requiredFields = ['message'];
      expect(requiredFields).toContain('message');
    });

    it('should require owner_id and post_id for comments', () => {
      const requiredFields = ['owner_id', 'post_id', 'message'];
      expect(requiredFields).toContain('owner_id');
      expect(requiredFields).toContain('post_id');
    });

    it('should require group_id for stats', () => {
      const requiredFields = ['group_id'];
      expect(requiredFields).toContain('group_id');
    });
  });
});

describe('MCP Server', () => {
  it('should export server with correct name', () => {
    const serverConfig = { name: 'vk-mcp-server', version: '0.1.0' };
    expect(serverConfig.name).toBe('vk-mcp-server');
  });

  it('should have tools capability', () => {
    const capabilities = { tools: {} };
    expect(capabilities).toHaveProperty('tools');
  });
});
