export class UserDto {
  id!: number;
  email!: string;
  name?: string | null;
  phone?: string | null;
  country?: string | null;
  createdAt!: Date;
}
