export interface CourierOffice {
  id: string;
  company: "econt" | "speedy";
  city: string;
  name: string;
  address: string;
}

export const courierOffices: CourierOffice[] = [
  // Econt offices
  { id: "eco-1", company: "econt", city: "София", name: "Офис Сердика", address: "ул. Сердика 4, София 1000" },
  { id: "eco-2", company: "econt", city: "София", name: "Офис Младост", address: "бул. Александър Малинов 51, София 1784" },
  { id: "eco-3", company: "econt", city: "Пловдив", name: "Офис Пловдив Център", address: "ул. Иван Вазов 5, Пловдив 4000" },
  { id: "eco-4", company: "econt", city: "Варна", name: "Офис Варна Центъра", address: "ул. Преслав 1, Варна 9000" },
  { id: "eco-5", company: "econt", city: "Бургас", name: "Офис Бургас Лазур", address: "ул. Крайезерна 42, Бургас 8000" },
  // Speedy offices
  { id: "spd-1", company: "speedy", city: "София", name: "Офис Надежда", address: "бул. Рожен 8, София 1220" },
  { id: "spd-2", company: "speedy", city: "София", name: "Офис Люлин", address: "ж.к. Люлин 2, бл. 205, София 1336" },
  { id: "spd-3", company: "speedy", city: "Пловдив", name: "Офис Тракия", address: "ж.к. Тракия, бл. 174, Пловдив 4023" },
  { id: "spd-4", company: "speedy", city: "Варна", name: "Офис Владислав Варненчик", address: "жк. Владислав Варненчик, бл. 301, Варна 9023" },
  { id: "spd-5", company: "speedy", city: "Стара Загора", name: "Офис Стара Загора Център", address: "ул. Цар Симеон Велики 110, Стара Загора 6000" },
];

export function getOfficesByCompany(company: "econt" | "speedy"): CourierOffice[] {
  return courierOffices.filter((o) => o.company === company);
}

export function getOfficeById(id: string): CourierOffice | undefined {
  return courierOffices.find((o) => o.id === id);
}
