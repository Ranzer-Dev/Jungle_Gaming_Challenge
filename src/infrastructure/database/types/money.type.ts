import { Type } from "@mikro-orm/core";
import { Money } from "../../domain/value-objects/money.value-object";

export class MoneyType extends Type<Money | undefined, string | undefined> {
  override convertToDatabaseValue(value: Money | undefined): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    return value.toString();
  }

  override convertToJSValue(value: string | undefined): Money | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    // Converte de decimal string ("25.00") para Money VO assumindo BRL no contexto padrão
    return Money.from({ amount: value, currency: "BRL" });
  }

  override getColumnType(): string {
    return "numeric(18, 2)";
  }
}
