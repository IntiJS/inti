import { describe, it, expect, beforeEach } from 'bun:test';
import { ComponentRegistry, registry } from '../src/registry/index.js';

describe('ComponentRegistry', () => {
    let testRegistry: ComponentRegistry;

    beforeEach(() => {
        testRegistry = new ComponentRegistry();
    });

    describe('register', () => {
        it('should register a block type with component', () => {
            testRegistry.register('hero', {
                component: () => Promise.resolve({ default: () => null })
            });

            expect(testRegistry.has('hero')).toBe(true);
        });

        it('should register with client directive', () => {
            testRegistry.register('interactive', {
                component: () => Promise.resolve({ default: () => null }),
                clientDirective: 'visible'
            });

            const registration = testRegistry.get('interactive');
            expect(registration?.clientDirective).toBe('visible');
        });

        it('should overwrite existing registration', () => {
            testRegistry.register('test', {
                component: () => Promise.resolve({ default: () => 'first' })
            });
            testRegistry.register('test', {
                component: () => Promise.resolve({ default: () => 'second' })
            });

            const registration = testRegistry.get('test');
            expect(registration).toBeDefined();
        });
    });

    describe('get', () => {
        it('should return registered block', () => {
            const mockComponent = () => Promise.resolve({ default: () => null });
            testRegistry.register('hero', { component: mockComponent });

            const registration = testRegistry.get('hero');
            expect(registration).toBeDefined();
            expect(registration?.component).toBe(mockComponent);
        });

        it('should return undefined for unregistered block', () => {
            const registration = testRegistry.get('nonexistent');
            expect(registration).toBeUndefined();
        });
    });

    describe('has', () => {
        it('should return true for registered block', () => {
            testRegistry.register('hero', {
                component: () => Promise.resolve({ default: () => null })
            });

            expect(testRegistry.has('hero')).toBe(true);
        });

        it('should return false for unregistered block', () => {
            expect(testRegistry.has('nonexistent')).toBe(false);
        });
    });

    describe('global registry', () => {
        it('should be a singleton', () => {
            expect(registry).toBeInstanceOf(ComponentRegistry);
        });

        it('should persist registrations', () => {
            registry.register('global-test', {
                component: () => Promise.resolve({ default: () => null })
            });

            expect(registry.has('global-test')).toBe(true);
        });
    });
});
