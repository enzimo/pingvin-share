import { Type } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

export class AppendFileDTO {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^[^/\\\u0000-\u001f\u007f]+$/)
  name: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  chunkIndex: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalChunks: number;
}
