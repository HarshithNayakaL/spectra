import {describe,expect,it} from "vitest";import {selectContract} from "./index";
it("selects restaurant information dimensions",()=>expect(selectContract({primaryEntity:{name:"A",type:"Organization",description:""},siteArchetype:"restaurant",secondaryArchetypes:[],purpose:[],importantInformationClasses:[],expectedUserQuestions:[],confidence:{overall:1,reasons:[]},ambiguities:[]}).dimensions.some(d=>d.id==="structured_evidence")).toBe(true));

