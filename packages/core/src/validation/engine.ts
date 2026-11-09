/**
 * ValidationEngine - Validation engine for IntiBlocks
 * Supports math, comparison, regex and custom rules
 */

import type {
    ValidationRule,
    ValidationResult,
    ValidationSummary,
    ValidationContext,
    MathValidationRule,
    RegexValidationRule,
    RangeValidationRule,
    ComparisonValidationRule,
    DependencyValidationRule,
    RequiredValidationRule,
    TypeValidationRule,
    CustomValidationRule,
    BlockValidationConfig
} from './types.js';

// ============================================
// Safe Math Expression Evaluator
// ============================================

export class MathEvaluator {
    /**
     * Safely evaluates a math expression
     * Only allows basic math operators and variables
     */
    static evaluate(expression: string, variables: Record<string, number>): boolean {
        try {
            // Replace variables with their values
            let evaluableExpr = expression;
            
            for (const [key, value] of Object.entries(variables)) {
                // Check that it is a number
                if (typeof value !== 'number' || isNaN(value)) {
                    return false;
                }
                evaluableExpr = evaluableExpr.replace(
                    new RegExp(`\\b${key}\\b`, 'g'),
                    String(value)
                );
            }
            
            // Check that it only contains allowed characters
            const allowedPattern = /^[0-9+\-*/().\s<>=!&|]+$/;
            if (!allowedPattern.test(evaluableExpr)) {
                console.warn('[MathEvaluator] Expression contains invalid characters:', evaluableExpr);
                return false;
            }
            
            // Evaluate safely using Function
            // This is safer than eval() because it runs in an isolated scope
            const func = new Function(`return (${evaluableExpr})`);
            const result = func();
            
            return Boolean(result);
        } catch (error) {
            console.warn('[MathEvaluator] Evaluation error:', error);
            return false;
        }
    }
    
    /**
     * Extracts all the variables from an expression
     */
    static extractVariables(expression: string): string[] {
        // Find words that are neither numbers nor operators
        const matches = expression.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
        // Filter out reserved words
        const reserved = ['true', 'false', 'null', 'undefined'];
        return [...new Set(matches.filter(v => !reserved.includes(v)))];
    }
}

// ============================================
// Validation Engine
// ============================================

export class ValidationEngine {
    private customValidators: Map<string, Function> = new Map();
    
    /**
     * Registers a global custom validator
     */
    registerCustomValidator(id: string, validator: (value: any, context: ValidationContext) => boolean | Promise<boolean>): void {
        this.customValidators.set(id, validator);
    }
    
    /**
     * Validates a single field
     */
    async validateField(
        rule: ValidationRule,
        context: ValidationContext
    ): Promise<ValidationResult> {
        const baseResult = {
            valid: true,
            severity: rule.severity || 'error',
            message: rule.message,
            field: context.fieldName
        };
        
        try {
            const isValid = await this.executeRule(rule, context);
            
            return {
                ...baseResult,
                valid: isValid
            };
        } catch (error) {
            return {
                ...baseResult,
                valid: false,
                message: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }
    
    /**
     * Runs a specific rule
     */
    private async executeRule(rule: ValidationRule, context: ValidationContext): Promise<boolean> {
        switch (rule.type) {
            case 'math':
                return this.executeMathRule(rule as MathValidationRule, context);
                
            case 'regex':
                return this.executeRegexRule(rule as RegexValidationRule, context);
                
            case 'range':
                return this.executeRangeRule(rule as RangeValidationRule, context);
                
            case 'comparison':
                return this.executeComparisonRule(rule as ComparisonValidationRule, context);
                
            case 'dependency':
                return this.executeDependencyRule(rule as DependencyValidationRule, context);
                
            case 'required':
                return this.executeRequiredRule(rule as RequiredValidationRule, context);
                
            case 'type':
                return this.executeTypeRule(rule as TypeValidationRule, context);
                
            case 'custom':
                return this.executeCustomRule(rule as CustomValidationRule, context);
                
            default:
                console.warn(`[ValidationEngine] Unknown rule type: ${(rule as any).type}`);
                return true;
        }
    }
    
    // ============================================
    // Specific Rule Executors
    // ============================================
    
    private executeMathRule(rule: MathValidationRule, context: ValidationContext): boolean {
        // Extract variables from the context
        const variables = rule.variables 
            ? Object.fromEntries(
                rule.variables.map(v => [v, this.getNumericValue(context.allValues[v])])
              )
            : Object.fromEntries(
                MathEvaluator.extractVariables(rule.expression).map(v => [
                    v, 
                    this.getNumericValue(context.allValues[v])
                ])
              );
        
        return MathEvaluator.evaluate(rule.expression, variables);
    }
    
    private executeRegexRule(rule: RegexValidationRule, context: ValidationContext): boolean {
        const regex = new RegExp(rule.pattern, rule.flags);
        const value = String(context.value || '');
        return regex.test(value);
    }
    
    private executeRangeRule(rule: RangeValidationRule, context: ValidationContext): boolean {
        const value = this.getNumericValue(context.value);
        
        if (isNaN(value)) return false;
        
        const min = rule.min !== undefined ? rule.min : -Infinity;
        const max = rule.max !== undefined ? rule.max : Infinity;
        
        if (rule.inclusive !== false) {
            return value >= min && value <= max;
        } else {
            return value > min && value < max;
        }
    }
    
    private executeComparisonRule(rule: ComparisonValidationRule, context: ValidationContext): boolean {
        const fieldValue = context.allValues[rule.field];
        const compareValue = rule.value !== undefined ? rule.value : context.value;
        
        switch (rule.operator) {
            case 'eq':
                return fieldValue === compareValue;
            case 'neq':
                return fieldValue !== compareValue;
            case 'lt':
                return fieldValue < compareValue;
            case 'lte':
                return fieldValue <= compareValue;
            case 'gt':
                return fieldValue > compareValue;
            case 'gte':
                return fieldValue >= compareValue;
            default:
                return false;
        }
    }
    
    private executeDependencyRule(rule: DependencyValidationRule, context: ValidationContext): boolean {
        // Check that all dependent fields exist and are not empty
        for (const depField of rule.dependsOn) {
            const depValue = context.allValues[depField];
            if (depValue === undefined || depValue === null || depValue === '') {
                return false;
            }
        }
        
        // If there is an additional condition, evaluate it
        if (rule.condition) {
            return MathEvaluator.evaluate(rule.condition, context.allValues);
        }
        
        return true;
    }
    
    private executeRequiredRule(rule: RequiredValidationRule, context: ValidationContext): boolean {
        const value = context.value;
        
        if (value === undefined || value === null) {
            return false;
        }
        
        if (!rule.allowEmpty && value === '') {
            return false;
        }
        
        if (Array.isArray(value) && value.length === 0) {
            return false;
        }
        
        return true;
    }
    
    private executeTypeRule(rule: TypeValidationRule, context: ValidationContext): boolean {
        const value = context.value;
        
        if (value === undefined || value === null) {
            return true; // The null/undefined type is handled by 'required'
        }
        
        switch (rule.expectedType) {
            case 'string':
                return typeof value === 'string';
            case 'number':
                return typeof value === 'number' && !isNaN(value);
            case 'boolean':
                return typeof value === 'boolean';
            case 'array':
                return Array.isArray(value);
            case 'object':
                return typeof value === 'object' && value !== null && !Array.isArray(value);
            case 'date':
                return value instanceof Date || !isNaN(Date.parse(value));
            default:
                return false;
        }
    }
    
    private async executeCustomRule(rule: CustomValidationRule, context: ValidationContext): Promise<boolean> {
        // First try the inline function
        if (rule.validator) {
            const result = await rule.validator(context.value, context);
            return result;
        }
        
        // Otherwise, look in the registered validators
        if (rule.validatorId && this.customValidators.has(rule.validatorId)) {
            const validator = this.customValidators.get(rule.validatorId)!;
            const result = await validator(context.value, context);
            return result;
        }
        
        console.warn(`[ValidationEngine] Custom validator not found: ${rule.validatorId}`);
        return true;
    }
    
    // ============================================
    // Helpers
    // ============================================
    
    private getNumericValue(value: any): number {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const parsed = parseFloat(value);
            return isNaN(parsed) ? NaN : parsed;
        }
        return NaN;
    }
    
    // ============================================
    // Full Block Validation
    // ============================================
    
    async validateBlock(
        config: BlockValidationConfig,
        values: Record<string, any>
    ): Promise<ValidationSummary> {
        const results: ValidationResult[] = [];
        
        // Validate each field
        for (const [fieldName, rules] of Object.entries(config.fields)) {
            const context: ValidationContext = {
                value: values[fieldName],
                allValues: values,
                fieldName,
                fieldPath: fieldName
            };
            
            for (const rule of rules) {
                const result = await this.validateField(rule, context);
                results.push(result);
            }
        }
        
        // Validate block-level rules (cross-field)
        if (config.blockRules) {
            const blockContext: ValidationContext = {
                value: values,
                allValues: values,
                fieldName: '__block__',
                fieldPath: '__block__'
            };
            
            for (const rule of config.blockRules) {
                const result = await this.validateField(rule, blockContext);
                results.push(result);
            }
        }
        
        const errors = results.filter(r => !r.valid && r.severity === 'error');
        const warnings = results.filter(r => !r.valid && r.severity === 'warning');
        const infos = results.filter(r => !r.valid && r.severity === 'info');
        
        return {
            valid: errors.length === 0,
            results,
            errors,
            warnings,
            infos,
            timestamp: Date.now()
        };
    }
}

// ============================================
// Global Instance
// ============================================

let globalEngine: ValidationEngine | null = null;

export function getValidationEngine(): ValidationEngine {
    if (!globalEngine) {
        globalEngine = new ValidationEngine();
    }
    return globalEngine;
}

export function createValidationEngine(): ValidationEngine {
    return new ValidationEngine();
}
