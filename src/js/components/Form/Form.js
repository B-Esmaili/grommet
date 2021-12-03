import React, {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MessageContext } from '../../contexts/MessageContext';
import { FormContext } from './FormContext';
import { FormPropTypes } from './propTypes';

const defaultValue = {};
const defaultTouched = {};
const defaultValidationResults = {
  errors: {},
  infos: {},
};

const stringToArray = (string) => {
  const match = string?.match(/^(.+)\[([0-9]+)\]\.(.*)$/);
  if (match) {
    const [, arrayName, indexOfArray, arrayObjName] = match;
    return {
      indexOfArray,
      arrayName,
      arrayObjName,
    };
  }
  return undefined;
};

const getValueForName = (name, value) => {
  const isArrayField = stringToArray(name);
  if (isArrayField) {
    const { indexOfArray, arrayName, arrayObjName } = isArrayField;
    const obj = value[arrayName]?.[indexOfArray];
    return arrayObjName ? obj?.[arrayObjName] : obj;
  }
  return value[name];
};

const setValueForName = (name, componentValue, prevValue) => {
  const nextValue = { ...prevValue };
  const isArrayField = stringToArray(name);
  if (isArrayField) {
    const { indexOfArray, arrayName, arrayObjName } = isArrayField;
    if (!nextValue[arrayName]) nextValue[arrayName] = [];
    if (arrayObjName) {
      if (!nextValue[arrayName][indexOfArray])
        nextValue[arrayName][indexOfArray] = {
          [arrayObjName]: componentValue,
        };
      nextValue[arrayName][indexOfArray][arrayObjName] = componentValue;
    } else nextValue[arrayName][indexOfArray] = componentValue;
  } else {
    nextValue[name] = componentValue;
  }
  return nextValue;
};

// Validating nameValues with the validator and sending correct messaging
const validate = (validator, nameValue, formValue, format, messages) => {
  let result;
  if (typeof validator === 'function') {
    result = validator(nameValue, formValue);
  } else if (validator.regexp) {
    if (!validator.regexp.test(nameValue)) {
      result = validator.message || format({ id: 'form.invalid', messages });
      if (validator.status) {
        result = { message: result, status: validator.status };
      }
    }
  }
  return result;
};

// Validates particular key in formValue
const validateName =
  (nameValidators, required) => (name, formValue, format, messages) => {
    const nameValue = getValueForName(name, formValue);
    let result;
    // ValidateArg is something that gets passed in from a FormField component
    // See 'validate' prop in FormField
    if (
      required &&
      // false is for CheckBox
      (nameValue === undefined ||
        nameValue === '' ||
        nameValue === false ||
        (Array.isArray(nameValue) && !nameValue.length))
    ) {
      // There is no value at that name, and one is required
      result = format({ id: 'form.required', messages });
    } else if (nameValidators) {
      if (Array.isArray(nameValidators)) {
        nameValidators.some((validator) => {
          result = validate(validator, nameValue, formValue, format, messages);
          return !!result;
        });
      } else {
        result = validate(
          nameValidators,
          nameValue,
          formValue,
          format,
          messages,
        );
      }
    }
    return result;
  };

// validations is an array from Object.entries()
// Validates all keys in formValue
const validateForm = (validations, formValue, format, messages, omitValid) => {
  const nextErrors = {};
  const nextInfos = {};
  validations.forEach(([name, { field, input }]) => {
    if (!omitValid) {
      nextErrors[name] = undefined;
      nextInfos[name] = undefined;
    }

    let result;
    if (input) {
      // input() are validations supplied through useFormInput()
      result = input(name, formValue, format, messages);
    }
    if (field && !result) {
      // field() are validations supplied through useFormField()
      result = field(name, formValue, format, messages);
    }
    // typeof error === 'object' is implied for both cases of error with
    // a status message and for an error object that is a react node

    // ???? Regardless of the typeof, don't these always resolve to
    // nextErrors[name] = result.message || result; ??????
    if (typeof result === 'object') {
      if (result.status === 'info') {
        nextInfos[name] = result.message;
      } else {
        nextErrors[name] = result.message || result; // could be a node
      }
    } else if (typeof result === 'string') {
      nextErrors[name] = result;
    }
  });
  return [nextErrors, nextInfos];
};

const Form = forwardRef(
  (
    {
      children,
      errors: errorsProp = defaultValidationResults.errors,
      infos: infosProp = defaultValidationResults.infos,
      messages,
      onChange,
      onReset,
      onSubmit,
      onValidate,
      validate: validateOn = 'submit',
      value: valueProp,
      ...rest
    },
    ref,
  ) => {
    const { format } = useContext(MessageContext);

    const [valueState, setValueState] = useState(valueProp || defaultValue);
    const value = useMemo(
      () => valueProp || valueState,
      [valueProp, valueState],
    );
    const [mounted, setMounted] = useState(false);
    const [touched, setTouched] = useState(defaultTouched);
    const [validationResults, setValidationResults] = useState({
      errors: errorsProp,
      infos: infosProp,
    });
    const validationResultsRef = useRef({});

    // when onBlur input validation is triggered, we need to complete any
    // potential click events before running the onBlur validation.
    // otherwise, click events like reset, etc. may not be registered.
    // for a detailed scenario/discussion,
    // see: https://github.com/grommet/grommet/issues/4863
    // the value of pendingValidation is the name of the FormField
    // awaiting validation.
    const [pendingValidation, setPendingValidation] = useState(undefined);

    const validations = useRef({});
    const requiredFields = useRef([]);

    const buildValid = useCallback(
      (nextErrors) => {
        let valid = false;
        valid = requiredFields.current
          .filter((n) => Object.keys(validations.current).includes(n))
          .every(
            (field) =>
              value[field] && (value[field] !== '' || value[field] !== false),
          );

        if (Object.keys(nextErrors).length > 0) valid = false;
        return valid;
      },
      [value],
    );

    // Only keep validation results for current form fields. In the case of a
    // dynamic form, a field possessing an error may have been removed from the
    // form; need to clean up any previous related validation results.
    const filterRemovedFields = (prevValidations) => {
      const nextValidations = prevValidations;
      return Object.keys(nextValidations)
        .filter(
          (n) => !validations.current[n] || nextValidations[n] === undefined,
        )
        .forEach((n) => delete nextValidations[n]);
    };

    const applyValidationRules = useCallback(
      (validationRules) => {
        let results;
        const [validatedErrors, validatedInfos] = validateForm(
          validationRules,
          value,
          format,
          messages,
        );

        setValidationResults((prevValidationResults) => {
          // Keep any previous errors and infos for untouched keys,
          // these may have come from a Submit.
          const nextErrors = {
            ...prevValidationResults.errors,
            ...validatedErrors,
          };
          const nextInfos = {
            ...prevValidationResults.infos,
            ...validatedInfos,
          };
          // Remove previous errors and infos for keys no longer in the
          // form, these may have been fields removed from a dynamic form.
          filterRemovedFields(nextErrors);
          filterRemovedFields(nextInfos);
          const nextValidationResults = {
            errors: nextErrors,
            infos: nextInfos,
          };
          if (onValidate)
            onValidate({
              ...nextValidationResults,
              valid: buildValid(nextErrors),
            });
          results = nextValidationResults;
          return nextValidationResults;
        });

        validationResultsRef.current = results;
        return results;
      },
      [buildValid, format, messages, onValidate, value],
    );

    // Validate all fields holding values onMount
    useEffect(() => {
      const validationRules = Object.entries(validations.current);

      if (!mounted) {
        // Simulated onMount state. "onMount" is simulated to account for a
        // controlled input scenario where an input has a value, however the
        // Form is unaware of the value held by the input until second render.
        if (
          Object.keys(value).length > 0 &&
          Object.keys(touched).length === 0
        ) {
          setMounted(true);
          applyValidationRules(
            validationRules
              .filter(([n]) => value[n])
              // Exlude empty arrays which may be initial values in
              // an input such as DateInput.
              .filter(
                ([n]) => !(Array.isArray(value[n]) && value[n].length === 0),
              ),
          );
        }
        // Form has been interacted with --> infer it has mounted.
        else if (Object.keys(touched).length > 0) {
          setMounted(true);
        }
      }
      return setMounted(false);
    }, [mounted, applyValidationRules, touched, value]);

    // Run validation against fields with pendingValidations from onBlur
    // and/or onChange.
    useEffect(() => {
      const validationRules = Object.entries(validations.current);
      const timer = setTimeout(() => {
        if (pendingValidation && ['blur', 'change'].includes(validateOn)) {
          applyValidationRules(
            validationRules.filter(
              ([n]) => touched[n] || pendingValidation.includes(n),
            ),
          );
          setPendingValidation(undefined);
        }
      }, 120);
      return () => clearTimeout(timer);
    }, [pendingValidation, applyValidationRules, touched, validateOn]);

    // Re-run validation rules for fields with prior errors.
    useEffect(() => {
      const validationRules = Object.entries(validations.current);
      if (
        validationResultsRef.current?.errors &&
        Object.keys(validationResultsRef.current.errors).length > 0
      ) {
        applyValidationRules(
          validationRules.filter(
            ([n]) => touched[n] && validationResultsRef.current.errors[n],
          ),
        );
      }
    }, [mounted, applyValidationRules, touched]);

    // There are three basic patterns of handling form input value state:
    //
    // 1 - form controlled
    //
    // In this model, the caller sets `value` and `onChange` properties
    // on the Form component to supply the values used by the input fields.
    // In useFormContext(), componentValue would be undefined and formValue
    // is be set to whatever the form state has. Whenever the form state
    // changes, we update the contextValue so the input component will use
    // that. When the input component changes, we will call update() to
    // update the form state.
    //
    // 2 - input controlled
    //
    // In this model, the caller sets `value` and `onChange` properties
    // on the input components, like TextInput, to supply the value for it.
    // In useFormContext(), componentValue is this value and we ensure to
    // update the form state, via update(), and set the contextValue from
    // the componentValue. When the input component changes, we will
    // call update() to update the form state.
    //
    // 3 - uncontrolled
    //
    // In this model, the caller doesn't set a `value` or `onChange` property
    // at either the form or input component levels.
    // In useFormContext(), componentValue is undefined and valueProp is
    // undefined and nothing much happens here. That is, unless the
    // calling component needs to know the state in order to work, such
    // as CheckBox or Select. In this case, those components supply
    // an initialValue, which will trigger updating the contextValue so
    // they can have access to it.
    //
    const useFormInput = ({
      name,
      value: componentValue,
      initialValue,
      validate: validateArg,
    }) => {
      const [inputValue, setInputValue] = useState(initialValue);
      const formValue = name ? getValueForName(name, value) : undefined;
      // for dynamic forms, we need to track when an input has been added to
      // the form value. if the input is unmounted, we will delete its key/value
      // from the form value.
      const keyCreated = useRef(false);

      // This effect is for pattern #2, where the controlled input
      // component is driving the value via componentValue.
      useEffect(() => {
        if (
          name && // we have somewhere to put this
          componentValue !== undefined && // input driving
          componentValue !== formValue // don't already have it
        ) {
          setValueState((prevValue) =>
            setValueForName(name, componentValue, prevValue),
          );
          // don't onChange on programmatic changes
        }
      }, [componentValue, formValue, name]);

      // on unmount, if the form is uncontrolled, remove the key/value
      // from the form value
      useEffect(
        () => () => {
          if (keyCreated.current) {
            keyCreated.current = false;
            setValueState((prevValue) => {
              const nextValue = { ...prevValue };
              const isArrayField = stringToArray(name);
              if (isArrayField) {
                const { arrayName } = isArrayField;
                delete nextValue[arrayName];
              } else {
                delete nextValue[name];
              }
              return nextValue;
            });
          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [], // only run onmount and unmount
      );

      // Create validation rules for fields
      useEffect(() => {
        if (validateArg) {
          if (!validations.current[name]) {
            validations.current[name] = {};
          }
          validations.current[name].input = validateName(validateArg);
          return () => delete validations.current[name].input;
        }
        return undefined;
      }, [validateArg, name]);

      let useValue;
      if (componentValue !== undefined)
        // input component drives, pattern #2
        useValue = componentValue;
      else if (valueProp && name && formValue !== undefined)
        // form drives, pattern #1
        useValue = formValue;
      else if (formValue === undefined && name)
        // form has reset, so reset input value as well
        useValue = initialValue;
      else useValue = inputValue;

      return [
        useValue,
        (nextComponentValue) => {
          if (name) {
            // we have somewhere to put this
            const nextTouched = { ...touched };
            nextTouched[name] = true;

            if (!touched[name]) {
              // don't update if not needed
              setTouched(nextTouched);
            }

            // if nextValue doesn't have a key for name, this must be
            // uncontrolled form. we will flag this field was added so
            // we know to remove its value from the form if it is dynamically
            // removed
            if (!(name in value)) keyCreated.current = true;
            const nextValue = setValueForName(name, nextComponentValue, value);
            setValueState(nextValue);
            if (onChange) onChange(nextValue, { touched: nextTouched });
          }
          if (initialValue !== undefined) setInputValue(nextComponentValue);
        },
      ];
    };

    const useFormField = ({
      error: errorArg,
      info: infoArg,
      name,
      required,
      disabled,
      validate: validateArg,
    }) => {
      const error = disabled
        ? undefined
        : errorArg || validationResults.errors[name];
      const info = infoArg || validationResults.infos[name];

      // Create validation rules for field
      useEffect(() => {
        const index = requiredFields.current.indexOf(name);
        if (required) {
          if (index === -1) requiredFields.current.push(name);
        } else if (index !== -1) requiredFields.current.splice(index, 1);

        if (validateArg || required) {
          if (!validations.current[name]) {
            validations.current[name] = {};
          }
          validations.current[name].field = validateName(validateArg, required);
          return () => delete validations.current[name].field;
        }

        return undefined;
      }, [error, name, required, validateArg, disabled]);

      return {
        error,
        info,
        inForm: true,
        onBlur:
          validateOn === 'blur'
            ? () =>
                setPendingValidation(
                  pendingValidation ? [...pendingValidation, name] : [name],
                )
            : undefined,
        onChange:
          validateOn === 'change'
            ? () =>
                setPendingValidation(
                  pendingValidation ? [...pendingValidation, name] : [name],
                )
            : undefined,
      };
    };

    return (
      <form
        ref={ref}
        {...rest}
        onReset={(event) => {
          setPendingValidation(undefined);
          if (!valueProp) {
            setValueState(defaultValue);
            if (onChange) onChange(defaultValue, { touched: defaultTouched });
          }
          setTouched(defaultTouched);
          setValidationResults(defaultValidationResults);

          if (onReset) {
            event.persist(); // extract from React's synthetic event pool
            const adjustedEvent = event;
            adjustedEvent.value = defaultValue;
            onReset(adjustedEvent);
          }
        }}
        onSubmit={(event) => {
          // Don't submit the form via browser form action. We don't want it
          // if the validation fails. And, we assume a javascript action handler
          // otherwise.
          event.preventDefault();
          setPendingValidation(undefined);
          const [nextErrors, nextInfos] = validateForm(
            Object.entries(validations.current),
            value,
            format,
            messages,
            true,
          );

          setValidationResults(() => {
            const nextValidationResults = {
              errors: nextErrors,
              infos: nextInfos,
              // Show form's validity when clicking on Submit
              valid: buildValid(nextErrors),
            };
            if (onValidate) onValidate(nextValidationResults);
            validationResultsRef.current = nextValidationResults;
            return nextValidationResults;
          });

          if (Object.keys(nextErrors).length === 0 && onSubmit) {
            event.persist(); // extract from React's synthetic event pool
            const adjustedEvent = event;
            adjustedEvent.value = value;
            adjustedEvent.touched = touched;
            onSubmit(adjustedEvent);
          }
        }}
      >
        <FormContext.Provider value={{ useFormField, useFormInput }}>
          {children}
        </FormContext.Provider>
      </form>
    );
  },
);

Form.displayName = 'Form';
Form.propTypes = FormPropTypes;

export { Form };
