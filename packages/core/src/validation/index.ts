/**
 * ValidatedBlocks - Validation system for Inti.js
 * 
 * Provides:
 * - Declarative block validation
 * - Safe math expression evaluation
 * - Visual validation feedback
 * - Server + client support
 */

// Types
export type {
    // Rules
    ValidationRule,
    ValidationRuleType,
    ValidationSeverity,
    ValidationTrigger,
    BaseValidationRule,
    MathValidationRule,
    RegexValidationRule,
    RangeValidationRule,
    ComparisonValidationRule,
    DependencyValidationRule,
    CustomValidationRule,
    RequiredValidationRule,
    TypeValidationRule,
    
    // Context and results
    ValidationContext,
    ValidationResult,
    ValidationSummary,
    
    // Block configuration
    BlockValidationConfig,
    ValidatedBlock,
    
    // Visual configuration
    ValidationInputConfig,
    ValidationOutputConfig,
    VisualValidationConfig,
    
    // Schema
    ValidationSchemaField,
    ValidationSchema
} from './types.js';

// Validation engine
export { 
    ValidationEngine, 
    MathEvaluator,
    getValidationEngine,
    createValidationEngine 
} from './engine.js';

// Helpers to create common rules
export function required(message = 'This field is required'): RequiredValidationRule {
    return {
        type: 'required',
        message,
        severity: 'error'
    };
}

export function math(
    expression: string, 
    message: string,
    variables?: string[]
): MathValidationRule {
    return {
        type: 'math',
        expression,
        message,
        variables,
        severity: 'error'
    };
}

export function range(
    min?: number, 
    max?: number, 
    message?: string,
    inclusive = true
): RangeValidationRule {
    return {
        type: 'range',
        min,
        max,
        message: message || `Must be between ${min} and ${max}`,
        inclusive,
        severity: 'error'
    };
}

export function regex(
    pattern: string, 
    message: string,
    flags?: string
): RegexValidationRule {
    return {
        type: 'regex',
        pattern,
        message,
        flags,
        severity: 'error'
    };
}

export function compare(
    field: string,
    operator: ComparisonValidationRule['operator'],
    value?: number | string | boolean,
    message?: string
): ComparisonValidationRule {
    const opLabels: Record<string, string> = {
        eq: 'equal to',
        neq: 'different from',
        lt: 'less than',
        lte: 'less than or equal to',
        gt: 'greater than',
        gte: 'greater than or equal to'
    };
    
    return {
        type: 'comparison',
        field,
        operator,
        value,
        message: message || `Must be ${opLabels[operator]} ${value || field}`,
        severity: 'error'
    };
}

export function dependsOn(
    fields: string[],
    message?: string
): DependencyValidationRule {
    return {
        type: 'dependency',
        dependsOn: fields,
        message: message || `Requires: ${fields.join(', ')}`,
        severity: 'error'
    };
}

export function custom(
    validatorId: string,
    message: string
): CustomValidationRule {
    return {
        type: 'custom',
        validatorId,
        message,
        severity: 'error'
    };
}

export function typeCheck(
    expectedType: TypeValidationRule['expectedType'],
    message?: string
): TypeValidationRule {
    return {
        type: 'type',
        expectedType,
        message: message || `Must be of type ${expectedType}`,
        severity: 'error'
    };
}

// Import types for the helper functions
import type { 
    RequiredValidationRule,
    MathValidationRule,
    RangeValidationRule,
    RegexValidationRule,
    ComparisonValidationRule,
    DependencyValidationRule,
    CustomValidationRule,
    TypeValidationRule
} from './types.js';
